# Putting the fitting room on a store

Two paths. Pick by what you need today.

- **[Path A — a demo you can show in 20 minutes](#path-a--the-demo-site)**: the service and the demo page, no Shopify at all. Real AI renders.
- **[Path B — the app on a Shopify store](#path-b--the-app-on-a-shopify-store)**: the real thing — customised prices in the cart and at checkout.

Do Path B on a **development store first**. It changes what customers are charged; you want a test order before it touches Tangelos.

---

## Path A — the demo site

The service serves the demo page, holds the Google key, and draws looks for real.

1. **Deploy this repo** to any Node 20+ host (Render, Railway, Fly). Build command: none. Start command: `npm start`.
2. **Set two variables:**
   ```
   GOOGLE_API_KEY=…          # from Google AI Studio
   FITTING_ROOM_TAX_RATE=0.1 # GST, if you are quoting Australian prices
   ```
3. **Open** `https://your-host/demo/index.html`.

That is the whole path. Nothing to install, no store involved. Good enough to show a merchant or put behind a link.

---

## Path B — the app on a Shopify store

### Before you start

| You need | Where from | Note |
| --- | --- | --- |
| A development store | Partner Dashboard → Stores | Do not start on the live store |
| An app | Dev/Partner Dashboard → Apps → Create app | **Custom distribution** — apps created inside the Shopify admin cannot use extensions |
| Shopify CLI | `npm i -g @shopify/cli` | Deploys the extension and the function |
| A host for this service | Render / Railway / Fly | Public HTTPS; Shopify has to reach it |
| A Google AI Studio key | aistudio.google.com | Only for "Draw the look" |

The store must have **Checkout Extensibility** for the cart transform to work.

### 1. Deploy the service

Deploy the repo, start command `npm start`. Note the URL — everything below points at it.

Run **one instance** for now: drafts and try-on sessions are in memory, so a second instance would lose them. Swap in Redis before you scale (`setSessionStore`, `setTryOnStore`).

### 2. Create the app and take its credentials

In the Dev/Partner Dashboard: create an app, choose **Custom distribution**, and copy the **Client ID** and **Client secret**.

### 3. Point the app at the service

In `shopify/shopify.app.toml`:

```toml
client_id = "<your client id>"
application_url = "https://your-host"

[app_proxy]
url = "https://your-host/apps/fitting-room"
subpath = "fitting-room"
prefix = "apps"
```

Scopes are already declared: `read_products`, `write_products`, `write_cart_transforms`, `read_orders`.

### 4. Deploy the extensions

```bash
cd shopify
shopify app deploy
```

That pushes three things: the app configuration (proxy + webhook + scopes), the **theme app extension** (the product-page block) and the **cart transform function**. Install the app on your development store with the link the dashboard gives you.

### 5. Give the service its credentials

```
SHOPIFY_SHOP=your-dev-store.myshopify.com
SHOPIFY_CLIENT_ID=…
SHOPIFY_CLIENT_SECRET=…
SHOPIFY_API_VERSION=2026-01
GOOGLE_API_KEY=…
```

No admin token needed: for a store in your own organisation the service mints its own token from the client credentials and re-mints it every day. (`SHOPIFY_ADMIN_TOKEN` still works if you would rather paste one; selling to other merchants later means the authorization code grant instead.)

`SHOPIFY_APP_SECRET` defaults to `SHOPIFY_CLIENT_SECRET`, which is what signs proxy requests and webhooks — set it explicitly only if they differ.

### 6. Put a fitting room on a product

```bash
npm run shopify:setup definition                 # install the metafield definition
npm run shopify:setup config <product-handle>    # configure that product
npm run shopify:setup check                      # confirm — lists what is configured
```

`config` copies the bundled shirt's option catalogue onto your product. Edit it afterwards in the admin: **Products → the product → Metafields → Fitting room**.

### 7. Add the block to the product page

**Online Store → Customize → Product template → Add block → Fitting room → Save.**

Load the product page. The options render, the price moves as you change them, and an impossible make-up (short sleeve + French cuff) flags the offending option.

### 8. Make the price stick at checkout

```bash
npm run shopify:setup cart-transform
```

That finds the deployed function and creates the cart transform. Without it the storefront prices correctly but the cart charges the base price.

### 9. Place a test order

Enable the bogus gateway (**Settings → Payments → test mode**), then:

1. Customise a garment and add it to the cart.
2. **Check the cart:** the line shows the make-up and the customised price.
3. **Check out** and place the order.
4. **Check the order:** the properties are on the line, and it is *not* tagged `fitting-room-price-mismatch`.

If the tag appears, the webhook re-priced the line and disagreed with what was charged — read `mismatches` in the response before shipping anything.

### 10. Repeat on the live store

Steps 5–9 against Tangelos, with a live-store install of the app. Deploy the app config again if the URLs changed.

---

## Troubleshooting

| What you see | What it means |
| --- | --- |
| Block shows "The fitting room answered 401" | Proxy signature failed — `SHOPIFY_APP_SECRET` does not match the app's client secret |
| Block shows "No product with slug…" | That product has no `fitting_room.config` metafield — run `shopify:setup config <handle>` |
| Storefront price right, cart price wrong | The cart transform is not installed — run `shopify:setup cart-transform` |
| `shopify_token_refused` in the logs | Client ID/secret wrong, or the app is not installed on that store |
| "Google refused that key…" | The Google key is wrong or has no billing enabled |
| Options render but nothing prices | The service cannot reach the Admin API — check `SHOPIFY_SHOP` and the logs |

## Worth knowing before real traffic

- **Every render costs money.** Cache looks by variant key, rate-limit per session, and watch the bill.
- **One instance only** until the session stores are swapped for Redis.
- **Tampering is detected, not prevented.** Cart line properties come from the browser; the webhook re-prices every customised line and tags mismatches. If you need prevention, use a server-created draft order instead of add-to-cart.
- **No customer photos.** The try-on draws a mannequin on purpose — photo-based try-on brings biometric privacy law with it.
