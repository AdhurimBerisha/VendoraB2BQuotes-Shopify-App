/// <reference types="vitest/config" />
import { reactRouter } from "@react-router/dev/vite";
import { sentryReactRouter } from "@sentry/react-router/vite";
import { defineConfig, type UserConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";
import { loadTestEnv } from "./app/test/test-db-url";

// Related: https://github.com/remix-run/remix/issues/2835#issuecomment-1144102176
// Replace the HOST env var with SHOPIFY_APP_URL so that it doesn't break the Vite server.
// The CLI will eventually stop passing in HOST,
// so we can remove this workaround after the next major release.
if (
  process.env.HOST &&
  (!process.env.SHOPIFY_APP_URL ||
    process.env.SHOPIFY_APP_URL === process.env.HOST)
) {
  process.env.SHOPIFY_APP_URL = process.env.HOST;
  delete process.env.HOST;
}

const host = new URL(process.env.SHOPIFY_APP_URL || "http://localhost")
  .hostname;

let hmrConfig;
if (host === "localhost") {
  hmrConfig = {
    protocol: "ws",
    host: "localhost",
    port: 64999,
    clientPort: 64999,
  };
} else {
  hmrConfig = {
    protocol: "wss",
    host: host,
    port: parseInt(process.env.FRONTEND_PORT!) || 8002,
    clientPort: 443,
  };
}

export default defineConfig((configEnv) => ({
  server: {
    allowedHosts: [host],
    cors: {
      preflightContinue: true,
    },
    port: Number(process.env.PORT || 3000),
    hmr: hmrConfig,
    fs: {
      // See https://vitejs.dev/config/server-options.html#server-fs-allow for more information
      allow: ["app", "node_modules"],
    },
  },
  plugins: [
    !process.env.VITEST && reactRouter(),
    // Uploads source maps and creates the release (git SHA) on build. Needs SENTRY_AUTH_TOKEN,
    // otherwise it skips the upload without failing the build.
    !process.env.VITEST &&
      sentryReactRouter({ org: "adhurimberisha", project: "vendora", authToken: process.env.SENTRY_AUTH_TOKEN }, configEnv),
    tsconfigPaths(),
  ],
  test: process.env.VITEST
    ? {
        env: loadTestEnv(), // test workers see the test DB + fake Shopify credentials
        globalSetup: ["app/test/global-setup.ts"],
        fileParallelism: false, // one shared DB → run test files one at a time
        testTimeout: 15_000,
      }
    : undefined,
  build: {
    assetsInlineLimit: 0,
  },
  optimizeDeps: {
    include: ["@shopify/app-bridge-react"],
  },
}) satisfies UserConfig);
