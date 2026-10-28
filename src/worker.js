/**
 * 1pay.cx for Shopify — lightweight "Pay with 1pay" bridge.
 *
 * Flow (no Shopify Payments-partner approval needed; runs as a Shopify custom app):
 *   1. The storefront posts the cart to POST /pay.
 *   2. This worker creates a Shopify DRAFT ORDER (Admin API) for those line items.
 *   3. It creates a 1pay payment for the draft total (notifyUrl -> /webhook,
 *      redirectUrl -> the shop) and 302-redirects the buyer to the hosted checkout.
 *   4. On payment, 1pay calls POST /webhook (HMAC-signed); the worker completes the
 *      draft order, turning it into a real paid Shopify order.
 *
 * Secrets (wrangler secret put): SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET for a
 *   Dev Dashboard app (or SHOPIFY_ADMIN_TOKEN for a legacy admin-created app),
 *   ONEPAY_API_KEY, and optionally ONEPAY_WEBHOOK_SECRET.
 * Vars (wrangler.toml): SHOPIFY_SHOP, ONEPAY_API_BASE, SHOPIFY_API_VERSION, SHOP_URL.
 */

/** Sent as `onepaycx-shopify/<version>` so the API records payments as created via Shopify. */
const BRIDGE_VERSION = '1.1.0';

const json = (obj, status = 200, extra = {}) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', ...extra } });

/**
 * CORS headers for the storefront. Only SHOP_URL may call cross-origin; there is no
 * wildcard fallback. With SHOP_URL unset no ACAO header is sent (browsers block the
 * response) and preflights are refused with 403.
 */
export function cors(env) {
  if (!env.SHOP_URL) {
    console.error('SHOP_URL is not set: refusing cross-origin requests');
    return {};
  }
  return {
    'Access-Control-Allow-Origin': env.SHOP_URL.replace(/\/+$/, ''),
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type',
    Vary: 'Origin',
  };
}

let cachedShopifyToken = null;

/** Dev Dashboard tokens expire after 24 hours. A legacy admin-created app may
 * still use its existing permanent token. */
export async function shopifyToken(env) {
  if (env.SHOPIFY_CLIENT_ID && env.SHOPIFY_CLIENT_SECRET) {
    const key = `${env.SHOPIFY_SHOP}:${env.SHOPIFY_CLIENT_ID}:${env.SHOPIFY_CLIENT_SECRET}`;
    if (cachedShopifyToken?.key === key && Date.now() < cachedShopifyToken.expiresAt) {
      return cachedShopifyToken.token;
    }
    const res = await fetch(`https://${env.SHOPIFY_SHOP}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: env.SHOPIFY_CLIENT_ID, client_secret: env.SHOPIFY_CLIENT_SECRET }),
    });
    if (!res.ok) throw new Error(`shopify token ${res.status}`);
    const data = await res.json();
    if (typeof data.access_token !== 'string' || !data.access_token || !Number.isFinite(Number(data.expires_in))) {
      throw new Error('shopify token response invalid');
    }
    cachedShopifyToken = {
      key,
      token: data.access_token,
      expiresAt: Date.now() + Math.max(0, Number(data.expires_in) - 300) * 1000,
    };
    return data.access_token;
  }
  if (env.SHOPIFY_ADMIN_TOKEN) return env.SHOPIFY_ADMIN_TOKEN;
  throw new Error('shopify credentials missing');
}

async function shopify(env, path, init = {}) {
  const version = env.SHOPIFY_API_VERSION || '2026-07';
  const token = await shopifyToken(env);
  const res = await fetch(`https://${env.SHOPIFY_SHOP}/admin/api/${version}${path}`, {
    ...init,
    headers: {
      'X-Shopify-Access-Token': token,
      'content-type': 'application/json',
      ...(init.headers || {}),
    },
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`shopify ${res.status}: ${body.slice(0, 200)}`);
  return body ? JSON.parse(body) : {};
}

/** Constant-time hex compare. */
function timingSafeEqualHex(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const WEBHOOK_TOLERANCE_S = 300;
const apiBase = (env) => env.ONEPAY_API_BASE || 'https://1pay.cx/api';
const keyIsTest = (env) => String(env.ONEPAY_API_KEY || '').startsWith('pk_test_');

let cachedSecret = null; // { key, secret } — secret for the configured key's mode

/**
 * The webhook secret for the configured API key's mode. Live and test payments are
 * signed with different secrets; GET /v1/me with the key returns the matching one.
 * ONEPAY_WEBHOOK_SECRET, when set, is used as-is (it must match the key's mode).
 */
export async function webhookSecret(env) {
  if (env.ONEPAY_WEBHOOK_SECRET) return env.ONEPAY_WEBHOOK_SECRET;
  if (!env.ONEPAY_API_KEY) return '';
  if (cachedSecret && cachedSecret.key === env.ONEPAY_API_KEY) return cachedSecret.secret;
  try {
    const r = await fetch(`${apiBase(env)}/v1/me`, {
      headers: { authorization: `Bearer ${env.ONEPAY_API_KEY}`, 'user-agent': `onepaycx-shopify/${BRIDGE_VERSION}` },
    });
    if (!r.ok) return '';
    const me = await r.json();
    if (typeof me.webhookSecret !== 'string' || !me.webhookSecret) return '';
    cachedSecret = { key: env.ONEPAY_API_KEY, secret: me.webhookSecret };
    return me.webhookSecret;
  } catch {
    return '';
  }
}

/**
 * Verify a delivery. Prefers `X-1pay-Signature-V2: t=<unix>,v1=<hex>` (HMAC of
 * `<t>.<body>`, |now - t| <= 300 s); falls back to the legacy `X-1pay-Signature`
 * (HMAC of the body) only when V2 is absent.
 */
export async function verifySignature(headers, raw, secret, nowS = Math.floor(Date.now() / 1000)) {
  if (!secret) return false;
  const v2 = headers.get('x-1pay-signature-v2');
  if (v2) {
    const parts = Object.fromEntries(
      v2.split(',').map((kv) => {
        const i = kv.indexOf('=');
        return [kv.slice(0, i).trim(), kv.slice(i + 1).trim()];
      }),
    );
    const t = Number(parts.t);
    if (!Number.isInteger(t) || !/^[0-9a-f]{64}$/i.test(parts.v1 || '')) return false;
    if (Math.abs(nowS - t) > WEBHOOK_TOLERANCE_S) return false;
    return timingSafeEqualHex(parts.v1.toLowerCase(), await hmacHex(secret, `${t}.${raw}`));
  }
  const sig = headers.get('x-1pay-signature') || '';
  return !!sig && timingSafeEqualHex(sig.toLowerCase(), await hmacHex(secret, raw));
}

const PAYMENT_ATTR = 'onepay_payment_id';

async function onepayPayment(env, paymentId) {
  const res = await fetch(`${apiBase(env)}/v1/payments/${encodeURIComponent(paymentId)}`, {
    headers: { authorization: `Bearer ${env.ONEPAY_API_KEY}`, 'user-agent': `onepaycx-shopify/${BRIDGE_VERSION}` },
  });
  if (!res.ok) throw new Error(`1pay payment ${res.status}`);
  return res.json();
}

/**
 * Everything the webhook acts on comes from the signed body: the draft id from
 * `data.reference` ("shopify:<id>"), status from `data.status`, and the amount and
 * currency and base amount must match the draft. Query-string params are ignored.
 * Returns { status, body } for the HTTP response.
 */
export async function handleWebhook(request, env, nowS) {
  const raw = await request.text();
  if (!(await verifySignature(request.headers, raw, await webhookSecret(env), nowS))) {
    return { status: 401, body: { error: 'bad_signature' } };
  }
  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    return { status: 400, body: { error: 'invalid_json' } };
  }
  const data = event && typeof event.data === 'object' && event.data ? event.data : null;
  if (!data) return { status: 400, body: { error: 'invalid_event' } };

  // Only a paid payment completes an order; other events are acknowledged and ignored.
  if (data.status !== 'paid') return { status: 200, body: { ok: true, ignored: 'not_paid' } };

  const ref = typeof data.reference === 'string' ? data.reference : '';
  const m = /^shopify:(\d+)$/.exec(ref);
  if (!m) return { status: 200, body: { ok: true, ignored: 'no_reference' } };
  const draftId = m[1];

  // A live key must never complete an order from a test payment.
  if (!keyIsTest(env) && data.livemode === false) {
    console.error('refusing test-mode payment for live store', data.paymentId);
    return { status: 400, body: { error: 'livemode_mismatch' } };
  }

  const paymentId = typeof data.paymentId === 'string' ? data.paymentId : '';
  if (!paymentId) return { status: 400, body: { error: 'missing_payment_id' } };

  let draft;
  try {
    ({ draft_order: draft } = await shopify(env, `/draft_orders/${draftId}.json`));
  } catch (e) {
    console.error('shopify draft fetch failed', String(e).slice(0, 200));
    return { status: 502, body: { error: 'draft_fetch_failed' } }; // let 1pay retry
  }
  if (!draft) return { status: 404, body: { error: 'draft_not_found' } };

  const attrs = Array.isArray(draft.note_attributes) ? draft.note_attributes : [];
  const recorded = attrs.find((a) => a && a.name === PAYMENT_ATTR);
  // The payment ID was stored before the buyer was sent to checkout. A signed
  // callback for a different payment must not be able to complete this draft.
  if (!recorded || recorded.value !== paymentId) {
    console.error('draft payment mismatch', draftId);
    return { status: 409, body: { error: 'payment_mismatch' } };
  }
  if (draft.status === 'completed' || draft.order_id) {
    return { status: 200, body: { ok: true, duplicate: true } };
  }

  let payment;
  try {
    payment = await onepayPayment(env, paymentId);
  } catch (e) {
    console.error('1pay payment fetch failed', String(e).slice(0, 200));
    return { status: 502, body: { error: 'payment_fetch_failed' } };
  }
  if (payment.id !== paymentId || payment.status !== 'paid' || payment.reference !== ref ||
      Boolean(payment.livemode) !== Boolean(data.livemode)) {
    return { status: 409, body: { error: 'payment_mismatch' } };
  }

  const amount = Number(data.amount);
  const storedAmount = Number(payment.amount);
  const baseAmount = Number(payment.baseAmount ?? payment.amount);
  const expected = Number(draft.total_price);
  if (!Number.isFinite(amount) || !Number.isFinite(storedAmount) || !Number.isFinite(baseAmount) ||
      !Number.isFinite(expected) || Math.abs(amount - storedAmount) > 0.01 || Math.abs(baseAmount - expected) > 0.01) {
    console.error('amount mismatch', draftId);
    return { status: 400, body: { error: 'amount_mismatch' } };
  }
  if (String(data.currency || '').toUpperCase() !== String(payment.currency || '').toUpperCase() ||
      String(payment.currency || '').toUpperCase() !== String(draft.currency || 'USD').toUpperCase()) {
    console.error('currency mismatch', draftId);
    return { status: 400, body: { error: 'currency_mismatch' } };
  }

  try {
    // Complete the draft as an order already paid (no pending balance).
    await shopify(env, `/draft_orders/${draftId}/complete.json?payment_pending=false`, { method: 'PUT' });
  } catch (e) {
    console.error('shopify complete failed', String(e).slice(0, 200));
    return { status: 502, body: { error: 'complete_failed' } }; // retry; the re-fetch dedupes
  }
  return { status: 200, body: { ok: true } };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      if (!env.SHOP_URL) {
        console.error('SHOP_URL is not set: refusing CORS preflight');
        return new Response(null, { status: 403 });
      }
      return new Response(null, { headers: cors(env) });
    }

    // --- Start a payment: create a draft order + a 1pay checkout, then redirect ---
    if (url.pathname === '/pay' && request.method === 'POST') {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: 'invalid_body' }, 400, cors(env));
      }
      const items = Array.isArray(body.items) ? body.items : [];
      if (!items.length) return json({ error: 'empty_cart' }, 400, cors(env));

      const lineItems = items
        .map((i) => ({ variant_id: Number(i.variant_id ?? i.id), quantity: Math.max(1, Number(i.quantity) || 1) }))
        .filter((i) => Number.isFinite(i.variant_id));
      if (!lineItems.length) return json({ error: 'invalid_items' }, 400, cors(env));

      try {
        // 1) Draft order in Shopify.
        const { draft_order: draft } = await shopify(env, '/draft_orders.json', {
          method: 'POST',
          body: JSON.stringify({
            draft_order: {
              line_items: lineItems,
              email: body.email || undefined,
              tags: '1pay',
              note: 'Paid via 1pay.cx',
            },
          }),
        });

        const amount = Number(draft.total_price);
        const currency = draft.currency || 'USD';

        // 2) 1pay hosted payment for the draft total. notifyUrl carries the draft id
        //    for logs only; the webhook trusts nothing but the signed `reference`.
        const notifyUrl = `${url.origin}/webhook?draft=${draft.id}`;
        const redirectUrl = env.SHOP_URL || undefined;
        const payRes = await fetch(`${env.ONEPAY_API_BASE || 'https://1pay.cx/api'}/v1/payments`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${env.ONEPAY_API_KEY}`,
            'content-type': 'application/json',
            // Lets 1pay.cx record the payment as created via Shopify.
            'user-agent': `onepaycx-shopify/${BRIDGE_VERSION}`,
          },
          body: JSON.stringify({
            amount,
            currency,
            notifyUrl,
            redirectUrl,
            reference: `shopify:${draft.id}`,
            productName: `Order ${draft.name || draft.id}`,
          }),
        });
        const pay = await payRes.json();
        if (!payRes.ok || !pay.checkoutUrl || !pay.id) {
          return json({ error: 'onepay_failed', detail: pay }, 502, cors(env));
        }
        await shopify(env, `/draft_orders/${draft.id}.json`, {
          method: 'PUT',
          body: JSON.stringify({ draft_order: {
            id: draft.id,
            note_attributes: [...(draft.note_attributes || []), { name: PAYMENT_ATTR, value: pay.id }],
          } }),
        });
        const checkoutUrl = pay.checkoutUrl.startsWith('http')
          ? pay.checkoutUrl
          : `${(env.ONEPAY_API_BASE || 'https://1pay.cx/api').replace(/\/api$/, '')}${pay.checkoutUrl}`;

        // Browser POST (form) -> redirect; fetch() caller -> JSON with the URL.
        if ((request.headers.get('accept') || '').includes('application/json')) {
          return json({ checkoutUrl }, 200, cors(env));
        }
        return Response.redirect(checkoutUrl, 302);
      } catch (e) {
        return json({ error: 'draft_failed', detail: String(e).slice(0, 200) }, 502, cors(env));
      }
    }

    // --- 1pay webhook: complete the draft order on a verified payment.paid ---
    if (url.pathname === '/webhook' && request.method === 'POST') {
      const res = await handleWebhook(request, env);
      return json(res.body, res.status);
    }

    // --- Health / info ---
    if (url.pathname === '/' ) {
      return json({ service: '1pay-for-shopify', ok: true });
    }
    return json({ error: 'not_found' }, 404);
  },
};
