# 1pay.cx for Shopify (self-hosted bridge)

> **Most merchants should not use this.** Shopify stores now connect from the 1pay
> dashboard (Settings › Plugins › Shopify): no Worker, no Cloudflare account, no Node,
> and buyers get the store's Shopify shipping rates, taxes and discounts. See
> `/docs/shopify` and `docs/agents/shopify.md`. This Worker remains for developers who
> want to run the bridge themselves; it does not collect a shipping address.

A lightweight "Pay with 1pay" bridge — accept card & crypto payments on Shopify,
settling in USDC to your own wallet, **with no KYB and no Shopify Payments approval**.

Shopify won't approve a no-KYC crypto-settlement gateway as a native payment method,
so this runs as a small **Cloudflare Worker** alongside a Shopify **custom app**
(no Partner Dashboard, no OAuth). The flow:

1. A "Pay with 1pay" button on your cart posts the cart to the worker.
2. The worker creates a Shopify **draft order** for those items.
3. It creates a **1pay hosted checkout** for the total and redirects the buyer there.
4. When the payment clears, 1pay calls the worker's signed webhook, which **completes
   the draft order** — turning it into a normal, paid Shopify order.

## Setup

### 1. Create a Shopify custom app
In Shopify admin open **Settings → Apps → Develop apps → Build apps in Dev Dashboard**.
Create an app, create and release a version with these Admin API scopes:
`write_draft_orders`, `read_draft_orders`, `write_orders`, `read_orders`.
Install the app on a store in the **same Shopify organization**. In the app's
**App settings**, copy its **Client ID** and **Client secret**. The worker exchanges
them for a Shopify access token and refreshes it before its 24-hour expiry.
New admin-created custom apps with a permanent token can no longer be created.
An existing app created in Shopify admin before 2026 may still use its Admin API
token with `SHOPIFY_ADMIN_TOKEN` instead.

### 2. Get your 1pay credentials
Use an **API key** with `payments:read` and `payments:write` from Settings → API & webhooks. The bridge supplies a per-payment
`notifyUrl` and fetches the matching account signing secret from `GET /v1/me` automatically.
Payments with `notifyUrl` send events only there; registered endpoints are skipped for those
payments and can remain saved for other integrations. If you explicitly set `ONEPAY_WEBHOOK_SECRET`, use the
account's **notifyUrl signing secret** for the API key's mode, never a registered endpoint's
secret. Use test keys and test secrets together; switch both for live payments.

### 3. Deploy the worker
```bash
cd workers/shopify
# edit wrangler.toml: SHOPIFY_SHOP, SHOP_URL
npx wrangler secret put SHOPIFY_CLIENT_ID
npx wrangler secret put SHOPIFY_CLIENT_SECRET
npx wrangler secret put ONEPAY_API_KEY
npx wrangler deploy
```
Note the deployed URL (e.g. `https://1pay-shopify.<you>.workers.dev`).

### 4. Add the button to your theme
On the cart page (`sections/cart.liquid` or a cart drawer), add:
```html
<button type="button" id="pay-1pay" class="button">Pay with card / crypto (1pay)</button>
<script>
  document.getElementById('pay-1pay').addEventListener('click', async () => {
    const cart = await fetch('/cart.js').then((r) => r.json());
    const items = cart.items.map((i) => ({ variant_id: i.variant_id, quantity: i.quantity }));
    const res = await fetch('https://1pay-shopify.<you>.workers.dev/pay', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ items }),
    }).then((r) => r.json());
    if (res.checkoutUrl) window.location = res.checkoutUrl;
    else alert('Payment could not be started.');
  });
</script>
```

Buyers who click the button pay via 1pay's hosted checkout and return to your
store; the matching order appears in Shopify as paid after the signed callback.
Use a development store and a 1pay test key before enabling a live cart button.
This button bypasses Shopify's native checkout: it does not collect a shipping
address or apply checkout-only discounts, shipping charges or taxes. Use it only
where the draft-order total and missing checkout information fit your products.

## Endpoints
- `POST /pay` — `{ items: [{ variant_id, quantity }], email? }` → `{ checkoutUrl }` (or a 302 for a plain form post).
- `POST /webhook` — 1pay's signed `payment.paid` callback; completes the draft order.
  - Signature: `X-1pay-Signature-V2: t=<unix>,v1=<hex>` (HMAC-SHA256 of `<t>.<raw body>`), refused
    if `t` is more than 5 minutes from now. Only when V2 is absent does it fall back to the legacy
    `X-1pay-Signature` (HMAC-SHA256 of the raw body).
  - Secret: `ONEPAY_WEBHOOK_SECRET` if set, else fetched once from `GET /v1/me` with `ONEPAY_API_KEY`.
    Live and test payments are signed with **different** secrets — a `pk_test_` key gets the test one.
  - Everything is taken from the signed body: the draft from `data.reference` (`shopify:<id>`), the
    status from `data.status` (must be `paid`). Query-string params are ignored.
  - The webhook amount must match the payment's stored amount; the payment's
    `baseAmount` must match the draft total (±0.01). This handles card surcharges.
  - A live key refuses `livemode: false` payments.
  - Dedupe: the payment id is recorded on the draft before redirect as the
    `onepay_payment_id` note attribute; a completed draft is never completed
    again, and a draft bound to another payment is refused (409).

## Notes
- Inventory/discounts/taxes follow whatever the Shopify draft order computes.
- The worker keys the order off the signed `reference = "shopify:<draftId>"` only.
- CORS: only `SHOP_URL` may call `/pay` cross-origin. If `SHOP_URL` is unset, no CORS header is
  sent and preflights get 403 (there is no `*` fallback).
- Tests: `node --test workers/shopify/test/worker.test.mjs`.
- For higher-touch storefronts, swap the cart button for an App-Proxy-backed page — the
  `/pay` + `/webhook` contract stays the same.
