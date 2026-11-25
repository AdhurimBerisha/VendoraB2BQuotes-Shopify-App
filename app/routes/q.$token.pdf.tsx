import type { LoaderFunctionArgs } from "react-router";
import { loadQuotePdfData, renderQuotePdf } from "../models/pdf.server";
import { PUBLIC_HEADERS, findPublicQuote, notFound, recordView } from "../models/public-quote.server";
import { unauthenticated } from "../shopify.server";

// Resource route (no UI): the PDF of the version in a signed link (M3.2).
export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { quote, version, superseded } = await findPublicQuote(request, params.token ?? "");
  if (superseded) throw notFound();
  await recordView(quote, version.versionNumber, "pdf"); // M10.3
  const { admin } = await unauthenticated.admin(quote.shop);
  const data = await loadQuotePdfData(admin, quote.shop, quote.id, version.versionNumber, "en");
  const pdf = await renderQuotePdf(data);
  return new Response(new Uint8Array(pdf), {
    headers: {
      ...PUBLIC_HEADERS,
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${data.numberLabel}-v${data.version}.pdf"`,
    },
  });
};
