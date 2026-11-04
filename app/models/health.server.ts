// Degraded mode (M4.2): is Shopify or the email provider failing right now?
// ponytail: in-memory, per process (the web server runs the workers too, see entry.server.tsx);
// with several instances, keep these counts in Postgres.
type Service = "shopify" | "email";

const WINDOW_MS = 5 * 60_000;
const MIN_FAILURES = 10;
const MAX_EVENTS = 1000;
const events: Record<Service, { at: number; ok: boolean }[]> = { shopify: [], email: [] };

const record = (service: Service, ok: boolean, now = Date.now()) => {
  const list = events[service];
  list.push({ at: now, ok });
  while (list.length > MAX_EVENTS || (list.length > 0 && list[0].at < now - WINDOW_MS)) list.shift();
};

// Degraded = at least 10 failures and not one success in the last 5 minutes.
const isDegraded = (service: Service, now = Date.now()) => {
  const recent = events[service].filter((event) => event.at >= now - WINDOW_MS);
  return recent.filter((event) => !event.ok).length >= MIN_FAILURES && !recent.some((event) => event.ok);
};

// For tests.
const resetHealth = () => {
  events.shopify = [];
  events.email = [];
};

export { isDegraded, record as recordHealth, resetHealth };
export type { Service };
