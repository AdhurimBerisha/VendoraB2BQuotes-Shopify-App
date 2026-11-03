import { existsSync, readFileSync } from "node:fs";

// Reads .env.test (local) or falls back to process.env (CI).
const loadTestEnv = (): Record<string, string> => {
  const env: Record<string, string> = {};
  if (existsSync(".env.test")) {
    for (const line of readFileSync(".env.test", "utf8").split(/\r?\n/)) {
      const match = /^\s*([A-Z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/.exec(line);
      if (match) env[match[1]] = match[2];
    }
  }
  env.DATABASE_URL ??= process.env.DATABASE_URL ?? "";
  env.APP_SIGNING_SECRET ??= "vitest-signing-secret"; // signed quote links (M3.2)
  if (!env.DATABASE_URL) {
    throw new Error("No test DATABASE_URL: create .env.test (see roadmap/dev/M1.2)");
  }
  // Safety: never reset a database whose name doesn't end in _test.
  const dbName = new URL(env.DATABASE_URL).pathname.slice(1);
  if (!dbName.endsWith("_test")) {
    throw new Error(`Refusing to use "${dbName}" for tests (name must end in _test)`);
  }
  return env;
};

export { loadTestEnv };
