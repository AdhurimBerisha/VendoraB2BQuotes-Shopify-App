// Public DSN (safe in client code); shared by the browser and server Sentry.init calls.
// Events are split by `environment`, so dev errors don't mix with production.
// Sentry runs only where SENTRY_ENVIRONMENT is set or in a production build, so a clone running
// `npm run dev` sends nothing to this project. Set SENTRY_ENVIRONMENT=development to report from dev.
export const sentryEnvironment = (): string | undefined =>
  process.env.SENTRY_ENVIRONMENT || (process.env.NODE_ENV === "production" ? "production" : undefined);

export const SENTRY_DSN =
  "https://56ed92e947380763530c9d435d0dab2e@o4510357860646912.ingest.de.sentry.io/4512409980043344";

// No personal data leaves the app: no user or IP-based location, cookies, request bodies or query strings
// (Shopify puts shop names and tokens in them). Used by both Sentry.init calls.
export const SENTRY_DATA_COLLECTION = {
  userInfo: false,
  cookies: false,
  httpBodies: [],
  urlQueryParams: false,
  httpHeaders: { allow: ["user-agent", "content-type"] },
};
