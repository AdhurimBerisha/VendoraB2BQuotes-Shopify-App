// eslint's node resolver reads the SDK's server build; tsc checks these browser exports.
/* eslint-disable import/namespace */
import * as Sentry from "@sentry/react-router";
import { startTransition, StrictMode } from "react";
import { hydrateRoot } from "react-dom/client";
import { HydratedRouter } from "react-router/dom";
import { SENTRY_DATA_COLLECTION, SENTRY_DSN } from "./lib/sentry";

Sentry.init({
  dsn: SENTRY_DSN,
  environment: import.meta.env.MODE,
  dataCollection: SENTRY_DATA_COLLECTION,
  integrations: [
    Sentry.reactRouterTracingIntegration(),
    // Text and media are masked by default: merchant and buyer data never leaves the browser.
    Sentry.replayIntegration({ maskAllText: true, blockAllMedia: true }),
  ],
  tracesSampleRate: import.meta.env.PROD ? 0.2 : 1.0,
  tracePropagationTargets: [/^\//],
  replaysSessionSampleRate: import.meta.env.PROD ? 0.1 : 1.0,
  replaysOnErrorSampleRate: 1.0,
});

startTransition(() => {
  hydrateRoot(
    document,
    <StrictMode>
      <HydratedRouter
        instrumentations={[Sentry.createSentryClientInstrumentation()]}
        onError={Sentry.sentryOnError}
      />
    </StrictMode>,
  );
});
