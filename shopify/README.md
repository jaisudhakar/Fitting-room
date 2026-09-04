# The Shopify app

Two extensions plus the app configuration. The service they talk to lives in the parent
directory — see `../docs/DEPLOYMENT.md` for the whole path.

```bash
npm install          # once, from this directory — the CLI needs the workspace installed
shopify app deploy
```

| Path | What it is |
| --- | --- |
| `shopify.app.toml` | Scopes, app proxy, webhooks. Set `client_id` and the URLs before deploying. |
| `extensions/fitting-room-ui/` | Theme app extension — the product-page block |
| `extensions/fitting-room-pricing/` | Cart transform function — applies the quoted price at checkout |

## About the function

It is written in JavaScript, so **there is no build command**: Shopify CLI compiles `src/`
with Javy. Adding an empty `[extensions.build] command = ""` to
`shopify.extension.toml` makes the CLI fail with *"doesn't have a build command or it's
empty"* — leave the block out.

The function deliberately does no arithmetic. It reads `_fitting_room_unit` (minor units)
off the cart line, which the service wrote after pricing the make-up server-side, and sets
that as the line price. Pricing lives in one place: `src/modules/fitting-room/pricing.js`.

`npm run typegen -w fitting-room-pricing` regenerates types from the input query if you
want them while editing.
