import * as Sentry from "@sentry/react-router";
import { SENTRY_DSN } from "./lib/sentry";

// Imported first by entry.server.tsx so Sentry is ready before any route code runs.
Sentry.init({
  dsn: SENTRY_DSN,
  enabled: process.env.NODE_ENV !== "test",
  environment: process.env.NODE_ENV ?? "development",
  tracesSampleRate: process.env.NODE_ENV === "production" ? 0.2 : 1.0,
});
