import "./instrument.server";
import * as Sentry from "@sentry/react-router";
import { PassThrough } from "stream";
import { renderToPipeableStream } from "react-dom/server";
import { ServerRouter } from "react-router";
import { createReadableStreamFromReadable } from "@react-router/node";
import { type EntryContext, type ServerInstrumentation } from "react-router";
import { isbot } from "isbot";
import { addDocumentResponseHeaders } from "./shopify.server";
import { startWorkers } from "./jobs/workers.server";
import { logger } from "./lib/logger.server";

// One worker set per server process. Set RUN_WORKERS=false on a web-only instance
// once workers move to their own service (D-13).
if (process.env.RUN_WORKERS !== "false" && process.env.NODE_ENV !== "test") {
  startWorkers().catch((error) => {
    globalThis.vendoraWorkersStarted = false; // let the next import retry
    logger.error({ error }, "[workers] failed to start");
  });
}

export const streamTimeout = 5000;

// M4.6: how long every loader and action takes (target: p95 under 1 s). One line per call;
// slow ones are warnings (and reach Sentry Logs).
const SLOW_MS = 1000;
const timed =
  (routeId: string, kind: "loader" | "action") =>
  async (handler: () => Promise<{ status: "success" | "error" }>, info: { pattern: string }) => {
    const start = performance.now();
    const { status } = await handler();
    const ms = Math.round(performance.now() - start);
    const fields = { route: routeId, kind, pattern: info.pattern, ms, status };
    if (ms >= SLOW_MS) logger.warn(fields, "slow route");
    else logger.info(fields, "route timing");
  };

export const instrumentations: ServerInstrumentation[] = [
  {
    route: (route) => route.instrument({ loader: timed(route.id, "loader"), action: timed(route.id, "action") }),
  },
  Sentry.createSentryServerInstrumentation(),
];

export const handleError = Sentry.createSentryHandleError({ logErrors: true });

async function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  reactRouterContext: EntryContext
) {
  addDocumentResponseHeaders(request, responseHeaders);
  const userAgent = request.headers.get("user-agent");
  const callbackName = isbot(userAgent ?? '')
    ? "onAllReady"
    : "onShellReady";

  return new Promise((resolve, reject) => {
    const { pipe, abort } = renderToPipeableStream(
      <ServerRouter
        context={reactRouterContext}
        url={request.url}
      />,
      {
        [callbackName]: () => {
          const body = new PassThrough();
          const stream = createReadableStreamFromReadable(body);

          responseHeaders.set("Content-Type", "text/html");
          resolve(
            new Response(stream, {
              headers: responseHeaders,
              status: responseStatusCode,
            })
          );
          pipe(body);
        },
        onShellError(error) {
          reject(error);
        },
        onError(error) {
          responseStatusCode = 500;
          logger.error({ error }, "render error");
        },
      }
    );

    // Automatically timeout the React renderer after 6 seconds, which ensures
    // React has enough time to flush down the rejected boundary contents
    setTimeout(abort, streamTimeout + 1000);
  });
}

export default Sentry.wrapSentryHandleRequest(handleRequest);
