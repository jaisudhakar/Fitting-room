# Fitting Room

A Node.js module set that adds a **fitting room** to an apparel product page: pick a size
(or go made-to-measure), choose the cut and the fabric, work through the make-up details,
add a monogram, and watch the price, the lead time and the manufacturing rules update live
before the garment goes in the basket.

Built around the *Beige Linen Shirt* product page, with a second product (*Stone Linen
Trousers*) included to prove that the catalogue is per-product configurable.

> **Note on the reference page.** The brief pointed at
> `https://ecommerce-clothes-1.aniq-ui.com/en/products/beige-linen-shirt`. That host is
> blocked by this environment's network egress policy, so the page could not be read. The
> feature set below is the standard fitting-room concept for that product; everything is
> data-driven, so swapping in the real option list means editing
> `src/data/products.json` and `src/modules/fitting-room/catalog.js` — no logic changes.

## Features

| Capability | Where |
| --- | --- |
| Option catalogue (size, fit, fabric, collar, sleeve, cuff, placket, pocket, buttons, hem) | `catalog.js` |
| Per-product overrides — hide a group or allow only some values | `data/products.json`, `repository.js` |
| Tailoring rules ("a short sleeve cannot take a cuff") | `catalog.js` → `OPTION_RULES`, `validator.js` |
| Made-to-measure: 7 body measurements with range checks | `catalog.js`, `validator.js` |
| Monogram: text, position, font, thread, with position rules | `catalog.js`, `validator.js` |
| Size recommendation from height / weight / build, with confidence and rationale | `sizing.js` |
| Live pricing in integer minor units, VAT, lead time, ship date | `pricing.js` |
| Draft sessions so a shopper can leave and come back | `session.js` |
| Cart line with a stable `variantKey` for basket de-duplication | `service.js` |
| Dependency-free JSON HTTP API | `http/router.js`, `routes.js`, `controller.js` |

Zero runtime dependencies. Node 20+.

## Getting started

```bash
npm start                          # http://localhost:3000
npm test                           # 69 tests, node:test
node examples/fitting-room-flow.js # the whole flow, no server needed
```

## Layout

```
src/
  index.js                     public exports
  app.js / server.js           HTTP bootstrap and graceful shutdown
  config/index.js              env-driven settings (currency, VAT, TTLs)
  http/router.js               tiny zero-dependency router + JSON handling
  data/products.json           products and their fitting-room configuration
  data/size-charts.json        body measurement ranges per size
  modules/fitting-room/
    catalog.js                 option groups, values, prices, rules, monogram, measurements
    repository.js              product lookup, per-product option resolution, defaults
    validator.js               normalisation + every rule that can reject a make-up
    pricing.js                 price breakdown, VAT, lead time, ship date
    sizing.js                  body-profile → size recommendation
    session.js                 draft store (in-memory, swappable)
    service.js                 orchestration: the API the rest of the app calls
    controller.js / routes.js  HTTP adapters
    errors.js                  typed errors that carry an HTTP status
```

The domain never imports the HTTP layer, so the module can be used directly from an
Express app, a Next.js route handler, a queue worker or a test.

## Using it as a library

```js
import { fittingRoomService as fittingRoom } from 'fitting-room';

const room = fittingRoom.getFittingRoom('beige-linen-shirt');       // everything the UI renders
const draft = fittingRoom.startSession('beige-linen-shirt');        // opens on the defaults
const state = fittingRoom.updateSession(draft.session.id, {         // patches merge
  options: { fabric: 'belgian-linen-180', cuff: 'french' },
  monogram: { text: 'JD', position: 'cuff-left', font: 'script', thread: 'navy' },
});

state.readyToAdd;            // false while anything is still invalid
state.validation.issues;     // [{ code, field, message, ... }]
state.price.formatted.total; // "€183.60"

const { cartLine } = fittingRoom.completeSession(draft.session.id);
```

Mounting the routes on an existing router:

```js
import { registerFittingRoomRoutes, Router } from 'fitting-room';

const router = registerFittingRoomRoutes(new Router(), { basePath: '/api/v1' });
http.createServer(router.handler()).listen(3000);
```

## HTTP API

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/fitting-room/health` | Liveness probe |
| `GET` | `/api/products` | Products that have a fitting room |
| `GET` | `/api/products/:slug/fitting-room` | Steps, option groups, catalogues, size chart, defaults, opening price |
| `POST` | `/api/products/:slug/fitting-room/size-recommendation` | Body profile → recommended size |
| `POST` | `/api/products/:slug/fitting-room/validate` | Validate a make-up, get issues and warnings |
| `POST` | `/api/products/:slug/fitting-room/quote` | Price a make-up (`?strict=true` refuses an invalid one) |
| `POST` | `/api/products/:slug/fitting-room/add-to-cart` | One-shot: validate, price, return a cart line |
| `POST` | `/api/products/:slug/fitting-room/sessions` | Open a draft |
| `GET` | `/api/fitting-room/sessions/:sessionId` | Read a draft with its live price and validation |
| `PATCH` | `/api/fitting-room/sessions/:sessionId` | Merge a change into the draft |
| `POST` | `/api/fitting-room/sessions/:sessionId/complete` | Turn the draft into a cart line and close it |
| `DELETE` | `/api/fitting-room/sessions/:sessionId` | Abandon the draft |

### Examples

```bash
# What can be customised
curl localhost:3000/api/products/beige-linen-shirt/fitting-room

# Which size am I?
curl -X POST localhost:3000/api/products/beige-linen-shirt/fitting-room/size-recommendation \
  -H 'content-type: application/json' \
  -d '{"heightCm":183,"weightKg":84,"bodyType":"athletic","fitPreference":"regular"}'

# Price a make-up
curl -X POST localhost:3000/api/products/beige-linen-shirt/fitting-room/quote \
  -H 'content-type: application/json' \
  -d '{"options":{"size":"l","fit":"relaxed","fabric":"stone-washed-linen","collar":"cutaway","sleeve":"long","cuff":"french","placket":"standard","pocket":"double-patch","buttons":"mother-of-pearl","hem":"straight"},
       "monogram":{"text":"JD","position":"cuff-left","font":"script","thread":"navy"},"quantity":1}'
```

Errors are typed and carry the offending field:

```json
{
  "error": {
    "code": "invalid_selection",
    "message": "The selection is not valid.",
    "details": [
      { "code": "rule_violation", "field": "options.cuff",
        "message": "A short sleeve is finished with a turn-up, so it cannot take a cuff.",
        "rule": "short-sleeve-has-no-cuff", "allowed": ["none"] }
    ]
  }
}
```

## How the pieces work

**Money** is handled in integer minor units (cents) everywhere; formatting happens once, at
the edge, via `Intl.NumberFormat`. An option can carry a negative delta (the linen/cotton
blend is cheaper than the house linen).

**Lead time accumulates.** Every step that needs extra work in the atelier — a special
fabric, a French cuff, a hidden placket, a monogram, made-to-measure — adds its days on top
of the product's stock lead time, and the quote returns an estimated ship date.

**Rules are data.** `OPTION_RULES` reads as "when *X* is one of …, then *Y* must be one
of …", and a rule is skipped automatically when a product does not offer one of its groups
— which is why the trousers, with no sleeve group, are never asked about cuffs.

**Sizing is explainable.** When the shopper gives only height and weight, the chest is
estimated from a conservative regression and adjusted for build; ease is then added for the
fit preference and the cut before matching against the size chart. The response says what
was measured, what was estimated, how confident the match is, and suggests made-to-measure
when the body falls between or outside the stock sizes.

**Validation never guesses.** A make-up is either manufacturable or it comes back with one
issue per problem. Warnings (measurements sent with a stock size, an unusual chest/waist
ratio) are reported separately and never block the basket.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` / `HOST` | `3000` / `0.0.0.0` | Where the server listens |
| `FITTING_ROOM_CURRENCY` | `EUR` | Fallback currency when the product has none |
| `FITTING_ROOM_LOCALE` | `en` | Locale used to format money |
| `FITTING_ROOM_TAX_RATE` | `0.2` | VAT applied to the line subtotal (`0` disables it) |
| `FITTING_ROOM_BASE_LEAD_TIME_DAYS` | `3` | Fallback stock lead time |
| `FITTING_ROOM_SESSION_TTL_MS` | `86400000` | How long a draft survives |
| `FITTING_ROOM_MAX_QUANTITY` | `10` | Per-line quantity cap |
| `CORS_ORIGIN` | `*` | Allowed storefront origin |

## Extending it

- **New option** — add a value to a group in `catalog.js`, then allow it on the product in
  `data/products.json`. Pricing, validation and the UI payload pick it up with no code change.
- **New rule** — append to `OPTION_RULES`.
- **New product** — add an entry to `data/products.json` with a `fittingRoom.groups` map.
- **Real persistence** — implement `create/read/write/delete/sweep` and call
  `setSessionStore(myStore)`; the in-memory store is only the default.
- **Real catalogue** — `repository.js` is the only file that reads the JSON files; point it
  at a database or a PIM and nothing else changes.

## Tests

```bash
npm test
```

`test/validator.test.js` (rules, measurements, monogram), `test/pricing.test.js` (money,
VAT, lead time), `test/sizing.test.js` (estimation and recommendation),
`test/service.test.js` (sessions, merging, cart lines) and `test/api.test.js` (the HTTP
surface, against a real server).
