# MAISON — React + Vite storefront on Odoo 19

The storefront shows live products, prices, variants, images and stock from Odoo 19 (`https://sys-go.com`, database `mylabo`). The browser never talks to Odoo directly. A small Node.js intermediary in `server/` signs in to Odoo's `/jsonrpc` endpoint with server-only credentials and exposes a fixed set of read-only catalog routes. It has no database and no inventory logic of its own.

```
Browser ──/api──▶ Vite dev server (127.0.0.1:5173) ──proxy──▶ server/index.js (127.0.0.1:8787) ──JSON-RPC execute_kw──▶ Odoo 19
```

## Setup (development)

1. Create a dedicated Odoo integration user (see below) and an API key for it.
2. `copy .env.example .env` and fill in `ODOO_USERNAME` and `ODOO_PASSWORD` (the API key).
3. `npm install`
4. Run both processes with `npm run dev:all`, or run them in two terminals with `npm run dev:api` and `npm run dev`.
5. Open http://127.0.0.1:5173

Both servers listen on loopback only. `.env` is git-ignored, is read only by `server/config.js`, and contains no `VITE_` variables, so nothing in it can end up in the browser bundle.

## Odoo integration user (least privilege)

- An internal user that is not an administrator, with an API key used as `ODOO_PASSWORD`.
- Rights: **Sales / Inventory: User** (read access to products, attributes and stock quantities). Website / eCommerce rights aren't required.
- The intermediary only calls `search_read`, `search_count`, `read` and `fields_get` on `product.template`, `product.product`, `product.template.attribute.value`, `product.attribute` and `product.public.category`. This allowlist is enforced in `server/odoo.js`.

## Which products are public

A product is shown only when it is active, **Can be Sold** (`sale_ok`), and carries the product tag named in `ODOO_STOREFRONT_TAG` (default `Storefront`). This is an explicit opt-in: to publish or unpublish a product, add or remove the tag in Odoo (Sales > Products > Tags field). If the Website/eCommerce app is installed later, products must also be **Published** (`is_published`).

Categories come from eCommerce categories (`public_categ_ids`), which exist only when eCommerce is installed. Without it, every product is listed under "All pieces". Internal product categories are never exposed.

## API

All responses are `{ "ok": true, "data": ..., "meta"?: ... }` or `{ "ok": false, "error": { "code", "message" } }`. Odoo errors are logged on the server and never returned to the browser.

| Route | Purpose |
|---|---|
| `GET /api/products?limit=1-48&offset=0-10000&category=<id>&q=<text>` | Published product templates with attributes, price range, currency and stock summary |
| `GET /api/products/:templateId` | One product, with all variants |
| `GET /api/products/:templateId/variants` | Variants (`product.product` ids) with resolved options and live stock |
| `GET /api/categories` | eCommerce categories that contain published products |
| `GET /api/images/(product\|variant)/:id/(128\|256\|512\|1024)` | Product image bytes (published products only; PNG/JPEG/WebP/GIF) |

The variant stock fields are `on_hand` (`qty_available`), `available` (`free_qty`, which is on hand minus reserved) and `in_stock` (`available > 0`). For products that don't track stock, `tracked` is `false`. Prices are the Odoo sales price plus attribute extras, **excluding taxes**. Pricelists aren't applied. Responses aren't cached, so every request reflects current Odoo data.

## Storefront behaviour

- The product modal loads fresh data and builds the size and color selectors from Odoo attributes. Once every option is chosen, it finds the matching `product.product` and shows its available stock. **Add to bag** is disabled when that variant has no available stock.
- Cart items store the Odoo variant id (`variantId`). Quantity is capped at the stock known when the item was added. Adding to the bag does **not** reserve stock, and the storefront says so.
- Checkout is disabled: there is no order endpoint, and nothing writes to Odoo.

## Tests

With the intermediary running, run `npm run test:api`. It checks authentication end to end, product, variant and attribute resolution, stock fields, images, input validation, and that credentials appear in neither API responses nor `dist/` (run `npm run build` first).

## Production (Contabo VPS behind Nginx). Not deployed yet

1. Build the frontend with `npm run build` and copy `dist/`, `server/` and `package.json` to `/opt/maison/app` on the VPS.
2. Put the production settings in `/etc/maison/catalog-api.env` (owner root, mode 600), based on `deploy/catalog-api.env.example`. That file is separate from your local `.env`.
3. Run the intermediary as an unprivileged `maison` user with systemd (`deploy/catalog-api.service.example`). It listens on `127.0.0.1:8787` only.
4. Nginx (`deploy/nginx.conf.example`) serves `dist/` over HTTPS and forwards **only** the catalog routes listed above, `GET` only and rate-limited. Any other `/api` path returns 404. Set `API_ALLOWED_HOSTS` to your public hostname.
5. Use a production API key that is different from the development one, and restrict the VPS firewall so only 80 and 443 are open.

Note: Odoo 19 still supports `/jsonrpc`, but Odoo has announced its replacement by the `/json/2` API. Only `server/odoo.js` would need to change.

## Files

- `server/config.js`: environment loading and validation
- `server/odoo.js`: JSON-RPC client with the model/method allowlist
- `server/catalog.js`: publication rule, attribute/variant resolution, response shaping
- `server/index.js`: HTTP routes, validation, error mapping, security headers, rate limit
- `src/api.js`: browser client (relative `/api` URLs only)
- `src/main.jsx`, `src/style.css`: storefront UI
- `vite.config.js`: `/api` proxy and loopback binding
- `deploy/`: production examples (Nginx, systemd, env)
