# Vendora

B2B quoting for Shopify Plus. Staff build quotes for a company location, with versions and approval rules, and Vendora turns an approved quote into a Shopify draft order and sends the invoice. Buyers see their quotes in their customer account or through a signed link.

Built on the Shopify React Router app template: React Router 7, Prisma on PostgreSQL, pg-boss for background jobs, Polaris web components, Sentry.

## Requirements

- Node 22.12 or newer
- Docker Desktop (PostgreSQL runs in a container)
- [Shopify CLI](https://shopify.dev/docs/apps/tools/cli/getting-started)
- Access to the Vendora app in the Shopify Dev Dashboard, and a dev store with B2B (companies)

## Setup

1. `npm install`
2. `npm run db:up` starts PostgreSQL 16 on port 5432 with two databases: `vendora` and `vendora_test`.
3. Create `.env` and `.env.test` (see [Environment](#environment)).
4. `npm run dev` applies pending migrations and starts the app through the Shopify CLI. Press `p` to open it and install it on the dev store.

## Environment

`.env`, used by `npm run dev`. The Shopify CLI supplies `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `SHOPIFY_APP_URL` and `SCOPES` itself.

| Variable | Local value | Notes |
|---|---|---|
| `DATABASE_URL` | `postgresql://vendora:vendora@localhost:5432/vendora?schema=public` | |
| `APP_SIGNING_SECRET` | any long random string | signs customer quote links; `APP_SIGNING_SECRET_OLD` keeps old links valid during a rotation |
| `RESEND_API_KEY` | optional | without it, notification emails are not sent |
| `EMAIL_FROM` | optional | sender address for notification emails |

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
| `SENTRY_ENVIRONMENT` | for example `staging`; defaults to `NODE_ENV` |
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
- Production hosting is not set up yet.
