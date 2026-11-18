import { Links, Meta, Outlet, Scripts, ScrollRestoration, useLoaderData } from "react-router";
import { sentryEnvironment } from "./lib/sentry";

// Tells the browser whether (and as which environment) to report to Sentry; see app/lib/sentry.ts.
export const loader = () => ({ sentryEnvironment: sentryEnvironment() ?? null });

export default function App() {
  const { sentryEnvironment } = useLoaderData<typeof loader>();
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        {sentryEnvironment && <meta name="sentry-environment" content={sentryEnvironment} />}
        {/* M4.6: in dev, App Bridge logs LCP, CLS and INP of each app load to the browser console. */}
        {import.meta.env.DEV && <meta name="shopify-debug" content="web-vitals" />}
        <link rel="preconnect" href="https://cdn.shopify.com/" />
        <link
          rel="stylesheet"
          href="https://cdn.shopify.com/static/fonts/inter/v4/styles.css"
        />
        <Meta />
        <Links />
      </head>
      <body>
        <Outlet />
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}
