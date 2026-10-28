import { execSync } from "node:child_process";
import { loadTestEnv } from "./test-db-url";

// Runs once per `vitest run`: applies pending migrations to the test DB.
// Never wipes data: tests isolate themselves with a random shop and clean up.
const setup = () => {
  const env = loadTestEnv();
  execSync("npx prisma migrate deploy", {
    stdio: "inherit",
    env: { ...process.env, ...env },
  });
};

export default setup;
