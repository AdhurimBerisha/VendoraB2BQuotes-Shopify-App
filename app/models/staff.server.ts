import type { Session } from "@shopify/shopify-app-react-router/server";
import db from "../db.server";
import { NotFoundError, UserError } from "../lib/errors";
import type { Role, StaffActor } from "./actor";
import { audit } from "./audit.server";
import { requirePermission } from "./permissions";

// Creates or refreshes the StaffMember for an online session's user. Returns null for offline sessions.
// The role is only chosen on the first visit; later changes come from Settings → Team and are kept,
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

const listStaff = (shop: string) =>
  db.staffMember.findMany({ where: { shop }, orderBy: { displayName: "asc" } });

// Settings → Team. A shop always keeps at least one OWNER.
const setRole = async (actor: StaffActor, staffId: string, role: Role) => {
  requirePermission(actor, "team.manage");

  await db.$transaction(async (tx) => {
    // Lock the shop row so two owners demoting each other at once can't leave zero owners.
    await tx.$executeRaw`SELECT 1 FROM "Shop" WHERE id = ${actor.shop} FOR UPDATE`;
    const target = await tx.staffMember.findFirst({ where: { id: staffId, shop: actor.shop } });
    if (!target) throw new NotFoundError();
    if (target.role === role) return;

    if (target.role === "OWNER") {
      const owners = await tx.staffMember.count({ where: { shop: actor.shop, role: "OWNER" } });
      if (owners <= 1) throw new UserError("team.errors.lastOwner");
    }
    await tx.staffMember.update({ where: { id: target.id }, data: { role } });
    await audit(tx, actor, null, "team.role_changed", { staffId, from: target.role, to: role });
    console.log("role changed", { shop: actor.shop, staffId, from: target.role, to: role });
  });
};

export { listStaff, setRole, upsertStaffFromSession };
