import { logger } from "../lib/logger.server";
import type { Session } from "@shopify/shopify-app-react-router/server";
import { z } from "zod";
import db from "../db.server";
import { EMAIL_TYPES, type EmailType } from "../emails/templates";
import { ForbiddenError, NotFoundError, UserError } from "../lib/errors";
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
    logger.info({ shop: actor.shop, staffId, from: target.role, to: role }, "role changed");
  });
};

// Settings → Notifications: each staff member sets only their own. Missing = on.
type NotificationPrefs = Record<EmailType, boolean>;

const getNotificationPrefs = async (actor: StaffActor) => {
  const member =
    actor.userId === null
      ? null
      : await db.staffMember.findUnique({
          where: { shop_shopifyUserId: { shop: actor.shop, shopifyUserId: actor.userId } },
          select: { email: true, notificationPrefs: true },
        });
  const saved = (member?.notificationPrefs ?? {}) as Record<string, unknown>;
  const prefs = Object.fromEntries(EMAIL_TYPES.map((type) => [type, saved[type] !== false])) as NotificationPrefs;
  return { email: member?.email ?? null, prefs };
};

const notificationPrefsFromForm = (form: FormData): NotificationPrefs =>
  Object.fromEntries(EMAIL_TYPES.map((type) => [type, form.get(type) === "on"])) as NotificationPrefs;

const saveNotificationPrefs = async (actor: StaffActor, prefs: NotificationPrefs) => {
  if (actor.userId === null) throw new ForbiddenError();
  await db.staffMember.update({
    where: { shop_shopifyUserId: { shop: actor.shop, shopifyUserId: actor.userId } },
    data: { notificationPrefs: prefs },
  });
  logger.info({ shop: actor.shop, off: EMAIL_TYPES.filter((type) => !prefs[type]) }, "notification prefs saved");
};

// M10.6: quote list views a staff member saved (name + the list's filter query, from viewQuery).
// Each member sees and changes only their own.
type SavedView = { name: string; query: string };
const SAVED_VIEWS_MAX = 20;
const VIEW_NAME_MAX = 40;
const savedViewsSchema = z.array(z.object({ name: z.string(), query: z.string() })).catch([]);

const ownStaff = (actor: StaffActor) => {
  if (actor.userId === null) throw new ForbiddenError();
  return { shop_shopifyUserId: { shop: actor.shop, shopifyUserId: actor.userId } };
};

const getSavedViews = async (actor: StaffActor): Promise<SavedView[]> => {
  if (actor.userId === null) return [];
  const member = await db.staffMember.findUnique({ where: ownStaff(actor), select: { savedViews: true } });
  return savedViewsSchema.parse(member?.savedViews ?? []);
};

// The same name (any case) replaces that view. query must come from viewQuery (normalized filters).
const saveView = async (actor: StaffActor, name: string, query: string) => {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > VIEW_NAME_MAX) throw new UserError("quotes.views.errors.name", { max: VIEW_NAME_MAX });
  if (!query) throw new UserError("quotes.views.errors.noFilters");
  const views = await getSavedViews(actor);
  const others = views.filter((view) => view.name.toLowerCase() !== trimmed.toLowerCase());
  if (others.length >= SAVED_VIEWS_MAX) throw new UserError("quotes.views.errors.tooMany", { max: SAVED_VIEWS_MAX });
  const next = [...others, { name: trimmed, query }];
  await db.staffMember.update({ where: ownStaff(actor), data: { savedViews: next } });
  logger.info({ shop: actor.shop, views: next.length }, "quote view saved");
};

const deleteView = async (actor: StaffActor, name: string) => {
  const views = await getSavedViews(actor);
  const next = views.filter((view) => view.name !== name);
  if (next.length === views.length) return; // already gone (another tab)
  await db.staffMember.update({ where: ownStaff(actor), data: { savedViews: next } });
  logger.info({ shop: actor.shop, views: next.length }, "quote view deleted");
};

export {
  deleteView,
  getSavedViews,
  getNotificationPrefs,
  listStaff,
  notificationPrefsFromForm,
  saveNotificationPrefs,
  saveView,
  setRole,
  upsertStaffFromSession,
};
export type { SavedView };
