import type { Config } from "@react-router/dev/config";
import { sentryOnBuildEnd } from "@sentry/react-router/vite";

// Uploads the server build's source maps to Sentry (client maps go through the Vite plugin).
export default {
  // React Router (7.18.5+) rejects form actions whose Origin (https://…) differs from request.url.
  // Render and the dev tunnel end TLS before the app and react-router-serve doesn't trust
  // X-Forwarded-Proto, so request.url is http://… and every action failed with 400 "Bad Request".
  // Keep in step with application_url in the shopify.app*.toml files.
  allowedActionOrigins: [
    "vendora-xxys.onrender.com", // production
    "vendora-staging-f4u9.onrender.com", // staging
    // `shopify app dev` sets SHOPIFY_APP_URL to this run's tunnel; Render builds don't have it.
    ...(process.env.SHOPIFY_APP_URL ? [new URL(process.env.SHOPIFY_APP_URL).host] : []),
  ],
  buildEnd: async ({ viteConfig, reactRouterConfig, buildManifest }) => {
    await sentryOnBuildEnd({ viteConfig, reactRouterConfig, buildManifest });
  },
} satisfies Config;
