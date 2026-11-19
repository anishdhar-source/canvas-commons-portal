# The Canvas Commons

A curated marketplace for original canvas art by India's independent artists:
storefront, artist desk and admin CMS.

## How it's built
- `docs/index.html`: the whole front end (storefront, artist desk, Studio admin CMS). It is bundled into the Worker and served at every non-API path. Opened without the API (for example on GitHub Pages) it shows built-in sample data.

**Live site:** https://canvas-commons.atraskianish.workers.dev
- `src/worker.js`: the API, running on Cloudflare Workers. It handles logins, artist uploads, curation, orders, leads and site content.
- `migrations/`: the Cloudflare D1 (SQLite) schema plus sample data.
- Artwork photos are stored in Cloudflare Workers KV.

## Run it locally
```bash
npm install
npx wrangler d1 migrations apply canvas-commons --local
echo "ADMIN_SETUP_CODE=choose-a-long-code" > .dev.vars
npx wrangler dev
```
Open http://localhost:8787, then go to `#setup` to create the first admin account with the setup code.

## Deploy to Cloudflare
1. `npx wrangler d1 create canvas-commons --location apac`, then put the id into `wrangler.toml` (already done for the live site)
2. `npx wrangler kv namespace create IMAGES`, then put the id into `wrangler.toml`
3. `npx wrangler d1 migrations apply canvas-commons --remote`
4. `npx wrangler secret put ADMIN_SETUP_CODE`
5. `npx wrangler deploy`

## Roles
- **Admin:** approves artists and listings, manages orders, leads and home page content.
- **Artist:** applies from the Artists page, then uploads works, sees orders and marks them packed or shipped.
- **Collector:** browses and orders. Payments are in test mode until Razorpay is connected.
