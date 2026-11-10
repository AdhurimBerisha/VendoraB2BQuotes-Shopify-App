import * as Sentry from "@sentry/react-router";
import { nodeProfilingIntegration } from "@sentry/profiling-node";
import { SENTRY_DSN } from "./lib/sentry";

const isProduction = process.env.NODE_ENV === "production";

// Imported first by entry.server.tsx so Sentry is ready before any route code runs.
Sentry.init({
  dsn: SENTRY_DSN,
  enabled: process.env.NODE_ENV !== "test",
  environment: process.env.NODE_ENV ?? "development",
  tracesSampleRate: isProduction ? 0.2 : 1.0,
  profileSessionSampleRate: isProduction ? 0.2 : 1.0,
  profileLifecycle: "trace",
  integrations: [
    nodeProfilingIntegration(),
    // Existing console.warn/error calls (slow routes, failed jobs) become Sentry logs; per-request info logs stay local.
    Sentry.consoleLoggingIntegration({ levels: ["warn", "error"] }),
  ],
});
