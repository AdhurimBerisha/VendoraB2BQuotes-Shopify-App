import db from "../db.server";

// Used by Render's health check and the uptime monitor. A database failure throws → 500 → unhealthy.
export const loader = async () => {
  await db.$queryRaw`SELECT 1`;
  return new Response("ok", { headers: { "Cache-Control": "no-store", "Content-Type": "text/plain" } });
};
