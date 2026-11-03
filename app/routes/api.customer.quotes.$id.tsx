import type { ActionFunctionArgs } from "react-router";
import { z } from "zod";
import { UserError } from "../lib/errors";
import { authenticateCustomer, customerAction } from "../models/customer-quotes.server";

const bodySchema = z.object({
  action: z.enum(["decline", "changes"]),
  message: z.string().trim().min(1).max(1000),
});

// POST { action: "decline" | "changes", message }: the buyer's answer to a sent quote (M3.4).
// Preflight (OPTIONS) is answered inside authenticateCustomer.
export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { actor, companyIds, cors } = await authenticateCustomer(request);
  const body = bodySchema.safeParse(await request.json().catch(() => null));
  if (!body.success) return cors(Response.json({ error: "errors.invalidInput" }, { status: 400 }));
  try {
    await customerAction(actor, companyIds, params.id ?? "", body.data.action, body.data.message);
    return cors(Response.json({ ok: true }));
  } catch (error) {
    // NotFoundError (another company's quote) → 404, ConflictError (not SENT) → 409.
    if (error instanceof UserError) return cors(Response.json({ error: error.key }, { status: error.status }));
    throw error;
  }
};
