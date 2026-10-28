// Shopify rejected the input; nothing was changed. Definite.
class ShopifyUserErrors extends Error {
  constructor(public messages: string[]) {
    super(messages.join("; "));
    this.name = "ShopifyUserErrors";
  }
}

// Rate limited; nothing happened. Retry soon.
class ShopifyThrottled extends Error {
  name = "ShopifyThrottled";
}

// The token lacks access (scope or plan). Definite.
class ShopifyDenied extends Error {
  name = "ShopifyDenied";
}

type GraphqlErrorLike = { extensions?: { code?: string }; message?: string };

// Runs an admin.graphql call and classifies failures. Anything not classified (network error,
// timeout, 5xx) is re-thrown as-is: for writes it means "may have happened".
// Library error shapes (@shopify/shopify-api lib/clients/common.mjs):
//  - GraphqlQueryError (HTTP 200 with GraphQL errors): error.body.errors.graphQLErrors[].extensions.code
//  - HttpThrottlingError (429) / HttpInternalError (5xx) / HttpResponseError: error.response.code
//  - HttpRequestError: no response at all (network) → unclassified
const call = async <T>(fn: () => Promise<T>): Promise<T> => {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof Response) throw error; // re-auth / redirect from the library
    const graphQLErrors =
      (error as { body?: { errors?: { graphQLErrors?: GraphqlErrorLike[] } } })?.body?.errors
        ?.graphQLErrors ?? [];
    const codes = graphQLErrors.map((graphQLError) => graphQLError.extensions?.code);
    const status = (error as { response?: { code?: number } })?.response?.code;
    const message = error instanceof Error ? error.message : String(error);
    if (status === 429 || codes.includes("THROTTLED")) throw new ShopifyThrottled(message);
    if (codes.includes("ACCESS_DENIED")) throw new ShopifyDenied(message);
    console.warn("shopify call failed (unclassified)", { status, message });
    throw error;
  }
};

const throwOnUserErrors = (userErrors?: { message: string }[] | null) => {
  if (userErrors?.length) throw new ShopifyUserErrors(userErrors.map((u) => u.message));
};

export { ShopifyDenied, ShopifyThrottled, ShopifyUserErrors, call, throwOnUserErrors };
