import { randomUUID } from "node:crypto";
import { type AdminApiContext, Session } from "@shopify/shopify-app-react-router/server";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import db from "../db.server";
import { ForbiddenError, NotFoundError } from "../lib/errors";
import { staff } from "../test/factories";
import type { Role } from "./actor";
import { redactShop } from "./privacy.server";
import { setRole, upsertStaffFromSession } from "./staff.server";

const SHOP = `vitest-${randomUUID()}.myshopify.com`;

afterAll(async () => {
  await redactShop(SHOP);
  await db.$disconnect();
});

type UserOverrides = Partial<NonNullable<Session["onlineAccessInfo"]>["associated_user"]>;

let nextUserId = 1000;
const onlineSession = (user: UserOverrides = {}) => {
  const id = user.id ?? nextUserId++;
  return new Session({
    id: `${SHOP}_${id}`,
    shop: SHOP,
    state: "",
    isOnline: true,
    onlineAccessInfo: {
      expires_in: 86400,
      associated_user_scope: "",
      associated_user: {
        id,
        first_name: "Ana",
        last_name: "Lopez",
        email: "ana@example.com",
        email_verified: true,
        account_owner: false,
        locale: "en",
        collaborator: false,
        ...user,
      },
    },
  });
};

test("store owner's first visit makes them OWNER", async () => {
  const staff = await upsertStaffFromSession(onlineSession({ account_owner: true }));
  expect(staff?.role).toBe("OWNER");
  expect(staff?.displayName).toBe("Ana Lopez");
  expect(staff?.email).toBe("ana@example.com");
});

test("normal staff first visit is REP", async () => {
  expect((await upsertStaffFromSession(onlineSession()))?.role).toBe("REP");
});

test("collaborator first visit is VIEWER", async () => {
  expect((await upsertStaffFromSession(onlineSession({ collaborator: true })))?.role).toBe("VIEWER");
});

test("a role changed in the app is kept on the next visit", async () => {
  const session = onlineSession();
  const staff = await upsertStaffFromSession(session);
  await db.staffMember.update({ where: { id: staff!.id }, data: { role: "MANAGER" } });

  expect((await upsertStaffFromSession(session))?.role).toBe("MANAGER");
});

test("name and language changes in Shopify are picked up", async () => {
  const id = nextUserId++;
  await upsertStaffFromSession(onlineSession({ id }));
  const staff = await upsertStaffFromSession(
    onlineSession({ id, first_name: "Anna", last_name: "Berg", locale: "de" }),
  );
  expect(staff?.displayName).toBe("Anna Berg");
  expect(staff?.locale).toBe("de");
  expect(await db.staffMember.count({ where: { shop: SHOP, shopifyUserId: BigInt(id) } })).toBe(1);
});

test("unverified email is not stored", async () => {
  const staff = await upsertStaffFromSession(onlineSession({ email_verified: false }));
  expect(staff?.email).toBeNull();
});

test("no name falls back to the email", async () => {
  const staff = await upsertStaffFromSession(onlineSession({ first_name: "", last_name: "" }));
  expect(staff?.displayName).toBe("ana@example.com");
});

test("offline session returns null", async () => {
  const session = new Session({ id: `offline_${SHOP}`, shop: SHOP, state: "", isOnline: false });
  expect(await upsertStaffFromSession(session)).toBeNull();
});

test("two requests at once on a first visit create one row", async () => {
  const session = onlineSession();
  await Promise.all([upsertStaffFromSession(session), upsertStaffFromSession(session)]);
  const userId = BigInt(session.onlineAccessInfo!.associated_user.id);
  expect(await db.staffMember.count({ where: { shop: SHOP, shopifyUserId: userId } })).toBe(1);
});

describe("setRole", () => {
  const admin = {} as AdminApiContext;
  const ROLE_SHOP = `vitest-${randomUUID()}.myshopify.com`;
  let userId = 1n;
  const member = (role: Role, shop = ROLE_SHOP) =>
    db.staffMember.create({
      data: { shop, shopifyUserId: userId++, displayName: `${role} ${userId}`, role },
    });
  const actorFor = (target: { shopifyUserId: bigint; role: string }) =>
    staff(ROLE_SHOP, admin, target.role as Role, target.shopifyUserId);

  beforeAll(async () => {
    await db.shop.create({ data: { id: ROLE_SHOP } });
  });
  afterAll(async () => {
    await redactShop(ROLE_SHOP);
  });

  test("an owner promotes a rep, and it's in the history", async () => {
    const owner = await member("OWNER");
    const rep = await member("REP");

    await setRole(actorFor(owner), rep.id, "MANAGER");

    expect((await db.staffMember.findUniqueOrThrow({ where: { id: rep.id } })).role).toBe("MANAGER");
    const event = await db.auditEvent.findFirstOrThrow({
      where: { shop: ROLE_SHOP, action: "team.role_changed" },
    });
    expect(event).toMatchObject({
      actorId: owner.shopifyUserId.toString(),
      data: { staffId: rep.id, from: "REP", to: "MANAGER" },
    });
  });

  test("the last owner can't be demoted", async () => {
    const shop = `vitest-${randomUUID()}.myshopify.com`;
    const owner = await member("OWNER", shop);
    await expect(
      setRole(staff(shop, admin, "OWNER", owner.shopifyUserId), owner.id, "MANAGER"),
    ).rejects.toMatchObject({ key: "team.errors.lastOwner" });
    await redactShop(shop);
  });

  test("a manager can't change roles", async () => {
    const manager = await member("MANAGER");
    const rep = await member("REP");
    await expect(setRole(actorFor(manager), rep.id, "MANAGER")).rejects.toBeInstanceOf(ForbiddenError);
  });

  test("staff from another shop can't be changed", async () => {
    const owner = await member("OWNER");
    const stranger = await member("REP", `vitest-${randomUUID()}.myshopify.com`);
    await expect(setRole(actorFor(owner), stranger.id, "OWNER")).rejects.toBeInstanceOf(NotFoundError);
    await redactShop(stranger.shop);
  });

  test("two owners demoting each other at once leave one owner", async () => {
    const shop = `vitest-${randomUUID()}.myshopify.com`;
    await db.shop.create({ data: { id: shop } });
    const first = await member("OWNER", shop);
    const second = await member("OWNER", shop);

    const results = await Promise.allSettled([
      setRole(staff(shop, admin, "OWNER", first.shopifyUserId), second.id, "REP"),
      setRole(staff(shop, admin, "OWNER", second.shopifyUserId), first.id, "REP"),
    ]);

    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(await db.staffMember.count({ where: { shop, role: "OWNER" } })).toBe(1);
    await redactShop(shop);
  });
});
