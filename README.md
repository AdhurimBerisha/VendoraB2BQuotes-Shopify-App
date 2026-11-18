# Vendora

B2B quoting for Shopify Plus. Staff build quotes for a company location, with versions and approval rules, and Vendora turns an approved quote into a Shopify draft order and sends the invoice. Buyers see their quotes in their customer account or through a signed link.

Built on the Shopify React Router app template: React Router 7, Prisma on PostgreSQL, pg-boss for background jobs, Polaris web components, Sentry.

## Requirements

- Node 22.12 or newer
- Docker Desktop (PostgreSQL runs in a container)
- [Shopify CLI](https://shopify.dev/docs/apps/tools/cli/getting-started)
- A Shopify app in the [Dev Dashboard](https://dev.shopify.com/dashboard) and a dev store with B2B (companies). To try Vendora on your own, see [Run your own copy](#run-your-own-copy)

## Run your own copy

You can clone this repository and run Vendora with your own free Shopify developer account. Nothing here connects to the maintainer's apps or servers. Suggestions are welcome as GitHub issues; changes to this repository are made by the maintainer.

1. **Accounts:** a free Shopify developer account ([dev.shopify.com](https://dev.shopify.com/dashboard)) and, in it, a **dev store with B2B** (a Shopify Plus dev store, so Customers → Companies exists).
2. **Your own app:** Dev Dashboard → *Create app* (any name) → copy its **client id**.
3. **App config:** `cp shopify.app.dev.toml shopify.app.local.toml`, then in the new file set `client_id` to your client id and `name` to your app's name. Leave the rest as it is (scopes, webhooks, app proxy). Run `shopify app config use local`. The file is gitignored.
4. **Protected customer data:** Dev Dashboard → your app → *API access requests* → *Protected customer data*: select a reason (*App functionality*) for the data and for Name, Email, Phone and Address, then save. Without it `shopify app dev` stops with "not approved to subscribe to webhook topics containing protected customer data".
5. **Local setup:** the [Setup](#setup) steps below. `npm run dev` asks for your dev store, creates the tunnel and installs the app there; press `p` to open it. The setup wizard takes you through the first quote.
6. **Sample data (optional):** if the store has no companies yet, `npx shopify store auth --store <shop>.myshopify.com --scopes write_products,write_customers`, then `node scripts/seed-store.mjs <shop>.myshopify.com`.

Good to know:
- **Emails** are skipped until you set a sender in `.env` (see [Environment](#environment)).
- **Error reporting** is off in your copy. `app/lib/sentry.ts` holds the maintainer's Sentry project; put your own DSN there before setting `SENTRY_ENVIRONMENT`.
- **Customer account "Quotes" page:** the extension finds its server by app client id (`BACKENDS` in `extensions/vendora-customer-quotes/src/QuotesPage.tsx`). Add your client id with the tunnel URL that `npm run dev` prints to try that page; everything else works without it.
- `npm run deploy` and `npm run deploy:staging` target the maintainer's apps; don't run them.

## Setup

1. `npm install`
2. `npm run db:up` starts PostgreSQL 16 on port 5432 with two databases: `vendora` and `vendora_test`.
3. `cp .env.example .env` and fill in `APP_SIGNING_SECRET`; create `.env.test` from the test block at the end of `.env.example` (see [Environment](#environment)).
4. `npm run dev` applies pending migrations and starts the app through the Shopify CLI. Press `p` to open it and install it on the dev store.

## Environment

`.env`, used by `npm run dev`. The Shopify CLI supplies `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `SHOPIFY_APP_URL` and `SCOPES` itself.

| Variable | Local value | Notes |
|---|---|---|
| `DATABASE_URL` | `postgresql://vendora:vendora@localhost:5432/vendora?schema=public` | |
| `APP_SIGNING_SECRET` | any long random string | signs customer quote links; `APP_SIGNING_SECRET_OLD` keeps old links valid during a rotation |
| `RESEND_API_KEY` | optional | sends notification emails through Resend (needs an own, verified domain) |
| `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN` | optional | used when `RESEND_API_KEY` is empty: sends through the Gmail API over HTTPS (works on hosts that block SMTP, like Render free). Setup below |
| `SMTP_URL` | optional | used when `RESEND_API_KEY` and the `GMAIL_*` trio are empty, e.g. Gmail with an app password: `smtps://you%40gmail.com:apppassword@smtp.gmail.com:465` |
| `EMAIL_FROM` | optional | sender address; with Gmail it must be that Gmail address. Without it and one of the senders above, notification emails are not sent |

**Gmail API setup (free, once):**
1. [Google Cloud console](https://console.cloud.google.com/) → new project → *APIs & Services* → enable **Gmail API**.
2. *OAuth consent screen*: External, add your Gmail as a test user, then **Publish app** (In production). While it stays in *Testing*, the refresh token dies after 7 days. Google's "unverified app" warning on step 4 is fine; only you sign in.
3. *Credentials* → Create OAuth client ID → **Web application**, redirect URI `https://developers.google.com/oauthplayground`. Copy the client id and secret.
4. [OAuth Playground](https://developers.google.com/oauthplayground) → gear icon → *Use your own OAuth credentials* (paste them) → scope `https://www.googleapis.com/auth/gmail.send` → Authorize (sign in with the sending Gmail) → *Exchange authorization code for tokens* → copy the **refresh token**.
5. Set `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN` and `EMAIL_FROM` (`Vendora <you@gmail.com>`) on the host. Leave `RESEND_API_KEY` empty.

`.env.test`, used by `npm test`. The database name must end in `_test`; the tests refuse to run otherwise.

| Variable | Value |
|---|---|
| `DATABASE_URL` | `postgresql://vendora:vendora@localhost:5432/vendora_test?schema=public` |
| `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET` | any placeholder |
| `SHOPIFY_APP_URL` | `https://vendora.test` |
| `SCOPES` | `read_products,read_customers,write_draft_orders` |

A hosted environment sets all of the above, plus:

| Variable | Notes |
|---|---|
| `SENTRY_ENVIRONMENT` | for example `staging`; turns on Sentry. Without it Sentry runs only in a production build (as `production`) |
| `SENTRY_AUTH_TOKEN` | build time only: uploads source maps to Sentry |
| `LOG_LEVEL` | optional, default `info` |
| `RUN_WORKERS` | optional; `false` stops this instance from running background jobs |

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | run the app locally through the Shopify CLI |
| `npm test` / `npm run test:watch` | unit and scenario tests against the test database and a fake Shopify |
| `npm run typecheck` | route type generation and `tsc` |
| `npm run lint` | ESLint |
| `npm run check:locales` | every locale has the keys the code uses |
| `npm run codegen` | regenerate GraphQL types in `app/types` after changing a query |
| `npm run build` | production build |
| `npm run deploy:staging` / `npm run deploy` | push app config and extensions to the staging or production Shopify app |
| `npm run db:up` / `npm run db:down` | start or stop the local PostgreSQL |

Database changes: edit `prisma/schema.prisma`, then add a migration under `prisma/migrations`. `npm run dev`, the tests and the Docker image apply pending migrations with `prisma migrate deploy`.

## Project layout

| Path | Contents |
|---|---|
| `app/routes` | admin pages, public quote pages (`q.$token`), app proxy, customer account API, webhooks |
| `app/models` | business logic: quotes, versions, pricing, approvals, sync, permissions |
| `app/shopify` | GraphQL queries and mutations against the Admin API |
| `app/jobs` | background jobs (draft order sync, emails, expiry, nightly reconcile, webhooks) |
| `app/lib` | shared helpers: money, dates, logging, signed links, rate limit |
| `app/locales` | translations |
| `app/test` | fake Shopify and test setup |
| `extensions` | customer account "Quotes" page and link, theme "Request a quote" block |
| `prisma` | schema and migrations |
| `load` | k6 load scripts and query plan checks |

## CI

Every push to `staging` or `main` and every pull request runs `.github/workflows/ci.yml`: lint, typecheck, locale check, app config sync check, tests against PostgreSQL, codegen check, production build and `npm audit`.

`shopify.app.toml` and `shopify.app.staging.toml` must agree on scopes, webhooks and the app proxy; `node scripts/check-toml-sync.mjs` checks it.

## Deploy

- The `staging` branch deploys to the staging host on push (Docker image, health check on `/healthz`).
- `npm run deploy:staging` pushes the Shopify app config and extensions for the staging app; `npm run deploy` does the same for the production app.
- The `main` branch deploys to the production host on push.

## License

[MIT](LICENSE). You may use, change and share the code, also in your own projects, as long as the copyright notice stays.
