// eslint's node resolver reads the SDK's server build; tsc checks these browser exports.
/* eslint-disable import/namespace */
import * as Sentry from "@sentry/react-router";
import { startTransition, StrictMode } from "react";
import { hydrateRoot } from "react-dom/client";
import { HydratedRouter } from "react-router/dom";
import { SENTRY_DSN } from "./lib/sentry";

Sentry.init({
  dsn: SENTRY_DSN,
  environment: import.meta.env.MODE,
  integrations: [Sentry.reactRouterTracingIntegration()],
  tracesSampleRate: import.meta.env.PROD ? 0.2 : 1.0,
  tracePropagationTargets: [/^\//],
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
