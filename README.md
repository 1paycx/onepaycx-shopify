# 1pay.cx for Shopify

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
Shopify admin → **Settings → Apps and sales channels → Develop apps → Create an app**.
Under **Configuration → Admin API integration**, grant these scopes:
`write_draft_orders`, `read_draft_orders`, `write_orders`, `read_orders`.
Install the app and copy the **Admin API access token**.

### 2. Get your 1pay credentials
From your 1pay.cx dashboard: an **API key** (Settings → API keys) and your
**webhook secret** (Settings). These authenticate payment creation and verify callbacks.

### 3. Deploy the worker
```bash
# edit wrangler.toml: SHOPIFY_SHOP, SHOP_URL
wrangler secret put SHOPIFY_ADMIN_TOKEN
wrangler secret put ONEPAY_API_KEY
wrangler secret put ONEPAY_WEBHOOK_SECRET
wrangler deploy
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

That's it. Buyers who click the button pay via 1pay's hosted checkout and land back on
your store; the matching order appears in Shopify as paid.

## Endpoints
- `POST /pay` — `{ items: [{ variant_id, quantity }], email? }` → `{ checkoutUrl }` (or a 302 for a plain form post).
- `POST /webhook` — 1pay's signed `payment.paid` callback; completes the draft order. Verified with `ONEPAY_WEBHOOK_SECRET` (HMAC-SHA256 over the raw body, `x-1pay-signature`).

## Notes
- Inventory/discounts/taxes follow whatever the Shopify draft order computes.
- The worker keys the order off `reference = "shopify:<draftId>"`, so callbacks always
  resolve to the right order even if the query string is stripped.
- For higher-touch storefronts, swap the cart button for an App-Proxy-backed page — the
  `/pay` + `/webhook` contract stays the same.

## Licence

MIT (see `LICENSE`).
