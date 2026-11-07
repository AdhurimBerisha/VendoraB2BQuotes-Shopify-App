import type { LoaderFunctionArgs } from "react-router";
import { getActor } from "../models/actor.server";
import { requirePermission } from "../models/permissions";
import { loadQuotePdfData, renderQuotePdf } from "../models/pdf.server";

// Resource route (no UI): the quote's PDF, current version or ?v=<number>.
export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const actor = await getActor(request);
  requirePermission(actor, "quote.view");
  const v = new URL(request.url).searchParams.get("v");
  const versionNumber = v && /^\d{1,4}$/.test(v) ? Number(v) : undefined;
  const data = await loadQuotePdfData(actor.admin, actor.shop, params.id ?? "", versionNumber, actor.locale);
  const pdf = await renderQuotePdf(data);
  return new Response(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${data.numberLabel}-v${data.version}.pdf"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
};
