import type { Session } from "@shopify/shopify-app-react-router/server";
import db from "../db.server";
import type { Role } from "./actor";

// Creates or refreshes the StaffMember for an online session's user. Returns null for offline sessions.
// The role is only chosen on the first visit; later changes come from Settings → Team (M2.4) and are kept,
// except that the store owner is always OWNER.
const upsertStaffFromSession = async (session: Session) => {
  const user = session.onlineAccessInfo?.associated_user;
  if (!user) return null;

  const shopifyUserId = BigInt(user.id);
  const name = [user.first_name, user.last_name].filter(Boolean).join(" ");
  const details = {
    displayName: name || user.email || `User ${user.id}`,
    email: user.email_verified ? user.email : null,
    locale: user.locale || "en",
  };
  const initialRole: Role = user.account_owner ? "OWNER" : user.collaborator ? "VIEWER" : "REP";

  return db.staffMember.upsert({
    where: { shop_shopifyUserId: { shop: session.shop, shopifyUserId } },
    create: { shop: session.shop, shopifyUserId, ...details, role: initialRole },
    update: {
      ...details,
      lastSeenAt: new Date(),
      ...(user.account_owner ? { role: "OWNER" } : {}),
    },
  });
};

export { upsertStaffFromSession };
