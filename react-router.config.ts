import type { Config } from "@react-router/dev/config";
import { sentryOnBuildEnd } from "@sentry/react-router/vite";

// Uploads the server build's source maps to Sentry (client maps go through the Vite plugin).
export default {
  buildEnd: async ({ viteConfig, reactRouterConfig, buildManifest }) => {
    await sentryOnBuildEnd({ viteConfig, reactRouterConfig, buildManifest });
  },
} satisfies Config;
