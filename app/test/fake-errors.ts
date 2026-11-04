// Errors shaped like the ones @shopify/shopify-api throws (lib/clients/common.mjs), so
// call() in app/shopify/client.server.ts classifies them exactly as it does in production.

// HTTP 200 with GraphQL errors (cost throttling, access denied, bad query): GraphqlQueryError.
const graphqlError = (code: string, message = code) =>
  Object.assign(new Error(message), {
    name: "GraphqlQueryError",
    body: { errors: { graphQLErrors: [{ message, extensions: { code } }] } },
  });

// HttpThrottlingError (429), HttpInternalError (5xx), HttpResponseError (other).
const httpError = (status: number) =>
  Object.assign(new Error(`HTTP ${status}`), {
    name: "HttpResponseError",
    response: { code: status, statusText: String(status), body: {} },
  });

// No response at all (network, timeout): HttpRequestError.
const networkError = () => Object.assign(new Error("socket hang up"), { name: "HttpRequestError" });

export { graphqlError, httpError, networkError };
