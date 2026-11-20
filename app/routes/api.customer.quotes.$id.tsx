import type { ActionFunctionArgs } from "react-router";
import { z } from "zod";
import { UserError } from "../lib/errors";
import { authenticateCustomer, customerAction, customerSetPoNumber } from "../models/customer-quotes.server";

const bodySchema = z.union([
  z.object({ action: z.enum(["decline", "changes"]), message: z.string().trim().min(1).max(1000) }),
  z.object({ action: z.literal("po"), poNumber: z.string().max(100) }), // M9.3, "" clears it
]);

// POST { action: "decline" | "changes", message } (M3.4) or { action: "po", poNumber } (M9.3).
// Preflight (OPTIONS) is answered inside authenticateCustomer.
export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { actor, companyIds, cors } = await authenticateCustomer(request);
  const body = bodySchema.safeParse(await request.json().catch(() => null));
  if (!body.success) return cors(Response.json({ error: "errors.invalidInput" }, { status: 400 }));
  try {
    const id = params.id ?? "";
    if (body.data.action === "po") await customerSetPoNumber(actor, companyIds, id, body.data.poNumber);
    else await customerAction(actor, companyIds, id, body.data.action, body.data.message);
    return cors(Response.json({ ok: true }));
  } catch (error) {
    // NotFoundError (another company's quote) → 404, ConflictError (not SENT) → 409.
    if (error instanceof UserError) return cors(Response.json({ error: error.key }, { status: error.status }));
    throw error;
  }
};
