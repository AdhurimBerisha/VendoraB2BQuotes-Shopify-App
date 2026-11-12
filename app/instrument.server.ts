import * as Sentry from "@sentry/react-router";
import { nodeProfilingIntegration } from "@sentry/profiling-node";
import { SENTRY_DATA_COLLECTION, SENTRY_DSN } from "./lib/sentry";

const isProduction = process.env.NODE_ENV === "production";

// Imported first by entry.server.tsx so Sentry is ready before any route code runs.
Sentry.init({
  dsn: SENTRY_DSN,
  enabled: process.env.NODE_ENV !== "test",
  // SENTRY_ENVIRONMENT=staging on the staging host; NODE_ENV is "production" there too.
  environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV ?? "development",
  tracesSampleRate: isProduction ? 0.2 : 1.0,
  profileSessionSampleRate: isProduction ? 0.2 : 1.0,
  profileLifecycle: "trace",
  dataCollection: SENTRY_DATA_COLLECTION,
  integrations: [
    nodeProfilingIntegration(),
    // Warnings and errors from the pino logger (slow routes, failed jobs) become Sentry logs; info lines stay local.
    Sentry.pinoIntegration({ log: { levels: ["warn", "error", "fatal"] } }),
    // The few console.warn calls left in files shared with the browser (permissions, approval rules).
    Sentry.consoleLoggingIntegration({ levels: ["warn", "error"] }),
  ],
});
