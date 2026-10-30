import { authenticate } from "../shopify.server";
import type { Role, StaffActor } from "./actor";
import { upsertStaffFromSession } from "./staff.server";

type AdminSession = Awaited<ReturnType<typeof authenticate.admin>>["session"];

// The single way routes learn who is acting. Use it in every action that changes data.
const getActor = async (request: Request): Promise<StaffActor & { session: AdminSession }> => {
  const { admin, session } = await authenticate.admin(request);
  const staff = await upsertStaffFromSession(session);
  if (!staff) console.warn("admin request without an online session", { shop: session.shop });

  return {
    type: "STAFF",
    shop: session.shop,
    userId: staff?.shopifyUserId ?? null,
    name: staff?.displayName ?? "Staff",
    role: (staff?.role ?? "REP") as Role,
    locale: staff?.locale ?? "en",
    admin,
    session,
  };
};

export { getActor };
