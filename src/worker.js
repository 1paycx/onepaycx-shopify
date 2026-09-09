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
 * Secrets (wrangler secret put): SHOPIFY_ADMIN_TOKEN, ONEPAY_API_KEY, ONEPAY_WEBHOOK_SECRET.
 * Vars (wrangler.toml): SHOPIFY_SHOP, ONEPAY_API_BASE, SHOPIFY_API_VERSION, SHOP_URL.
 */

const json = (obj, status = 200, extra = {}) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', ...extra } });

function cors(env) {
  const origin = env.SHOP_URL || '*';
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type',
  };
}

async function shopify(env, path, init = {}) {
  const version = env.SHOPIFY_API_VERSION || '2024-10';
  const res = await fetch(`https://${env.SHOPIFY_SHOP}/admin/api/${version}${path}`, {
    ...init,
    headers: {
      'X-Shopify-Access-Token': env.SHOPIFY_ADMIN_TOKEN,
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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') return new Response(null, { headers: cors(env) });

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
        //    so the webhook can complete the right order.
        const notifyUrl = `${url.origin}/webhook?draft=${draft.id}`;
        const redirectUrl = env.SHOP_URL ? `${env.SHOP_URL}/pages/thank-you` : undefined;
        const payRes = await fetch(`${env.ONEPAY_API_BASE || 'https://1pay.cx/api'}/v1/payments`, {
          method: 'POST',
          headers: { authorization: `Bearer ${env.ONEPAY_API_KEY}`, 'content-type': 'application/json' },
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
        if (!payRes.ok || !pay.checkoutUrl) {
          return json({ error: 'onepay_failed', detail: pay }, 502, cors(env));
        }
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

    // --- 1pay webhook: mark the draft order paid on payment.paid ---
    if (url.pathname === '/webhook' && request.method === 'POST') {
      const raw = await request.text();
      const sig = request.headers.get('x-1pay-signature') || '';
      const expected = await hmacHex(env.ONEPAY_WEBHOOK_SECRET || '', raw);
      if (!sig || !timingSafeEqualHex(sig, expected)) return json({ error: 'bad_signature' }, 401);

      let event;
      try {
        event = JSON.parse(raw);
      } catch {
        return json({ error: 'invalid_json' }, 400);
      }
      // Draft id from the notifyUrl query, or the reference ("shopify:<id>").
      const draftId =
        url.searchParams.get('draft') ||
        (typeof event.reference === 'string' && event.reference.startsWith('shopify:')
          ? event.reference.slice('shopify:'.length)
          : null);
      const paid = event.status === 'paid' || (request.headers.get('x-1pay-event') || '') === 'payment.paid';
      if (paid && draftId) {
        try {
          // Complete the draft as an order already paid (no pending balance).
          await shopify(env, `/draft_orders/${draftId}/complete.json?payment_pending=false`, { method: 'PUT' });
        } catch (e) {
          // Ack anyway so 1pay doesn't hammer retries; log for the merchant.
          console.error('shopify complete failed', String(e).slice(0, 200));
        }
      }
      return json({ ok: true });
    }

    // --- Health / info ---
    if (url.pathname === '/' ) {
      return json({ service: '1pay-for-shopify', ok: true });
    }
    return json({ error: 'not_found' }, 404);
  },
};
