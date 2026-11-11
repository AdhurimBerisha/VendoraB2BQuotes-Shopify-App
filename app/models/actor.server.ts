import * as Sentry from "@sentry/react-router";
import { logger } from "../lib/logger.server";
import { authenticate } from "../shopify.server";
import type { Role, StaffActor } from "./actor";
import { upsertStaffFromSession } from "./staff.server";

type AdminSession = Awaited<ReturnType<typeof authenticate.admin>>["session"];

// The single way routes learn who is acting. Use it in every action that changes data.
const getActor = async (request: Request): Promise<StaffActor & { session: AdminSession }> => {
  const { admin, session } = await authenticate.admin(request);
  Sentry.setTag("shop", session.shop); // every error from this request says which shop hit it
  const staff = await upsertStaffFromSession(session);
  if (!staff) logger.warn({ shop: session.shop }, "admin request without an online session");

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
