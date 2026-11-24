import { createHmac } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import db from "../db.server";
import { enqueue } from "../jobs/queue.server";
import { testQuote, testShop } from "../test/factories";
import type { CustomerActor } from "./actor";
import { attentionItems } from "./attention";
import { authenticateCustomer, customerAction, customerSetPoNumber, listCustomerQuotes, shopFromDest } from "./customer-quotes.server";
import { redactShop } from "./privacy.server";

vi.mock("../jobs/queue.server", () => ({ enqueue: vi.fn(async () => "job-id"), getBoss: vi.fn(async () => ({})) }));
const enqueueMock = vi.mocked(enqueue);

const COMPANY_A = "gid://shopify/Company/1";
const COMPANY_B = "gid://shopify/Company/2";
const REP = 5n;

let SHOP: string;
let actor: CustomerActor;

beforeAll(async () => {
  process.env.APP_SIGNING_SECRET ??= "test-secret";
  SHOP = (await testShop({ quotePrefix: "Q-" })).id;
  actor = { type: "CUSTOMER", shop: SHOP, customerId: "gid://shopify/Customer/1" };
  await db.staffMember.create({
    data: { shop: SHOP, shopifyUserId: REP, displayName: "Rep", role: "REP", email: "rep@shop.test" },
  });
});

beforeEach(() => enqueueMock.mockClear());

afterAll(async () => {
  await redactShop(SHOP);
  await db.$disconnect();
});

const sentQuote = (overrides = {}) =>
  testQuote(SHOP, { overrides: { status: "SENT", assignedToUserId: REP, invoiceUrl: "https://shop.test/invoice", ...overrides } });

const jobs = (name: string) => enqueueMock.mock.calls.filter(([queue]) => queue === name).map(([, data]) => data);

const statusOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
    return 200;
  } catch (error) {
    return (error as { status?: number }).status;
  }
};

// A session token signed with the wrong secret, otherwise well-formed (M4.5).
const forgedToken = () => {
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const body = `${part({ alg: "HS256", typ: "JWT" })}.${part({
    iss: `https://${SHOP}/admin`,
    dest: `https://${SHOP}`,
    aud: process.env.SHOPIFY_API_KEY,
    sub: "gid://shopify/Customer/1",
    exp: now + 60,
    nbf: now - 60,
    iat: now,
  })}`;
  return `${body}.${createHmac("sha256", "not-the-app-secret").update(body).digest("base64url")}`;
};

test("customer API without a token or with a forged one → 401", async () => {
  const request = (headers: Record<string, string>) =>
    new Request("https://vendora.test/api/customer/quotes", { headers: { Origin: "https://extensions.shopifycdn.com", ...headers } });
  const statusOfAuth = (req: Request) =>
    authenticateCustomer(req).then(
      () => 200,
      (thrown: unknown) => (thrown instanceof Response ? thrown.status : thrown),
    );

  expect(await statusOfAuth(request({}))).toBe(401);
  expect(await statusOfAuth(request({ Authorization: `Bearer ${forgedToken()}` }))).toBe(401);
});

test("shopFromDest: domain with or without https://", () => {
  expect(shopFromDest("https://a.myshopify.com")).toBe("a.myshopify.com");
  expect(shopFromDest("a.myshopify.com")).toBe("a.myshopify.com");
});

test("lists only the buyer's companies' sent and closed quotes, without internal data", async () => {
  const visible = await Promise.all(
    ["SENT", "ORDERED", "DECLINED", "EXPIRED"].map((status) => testQuote(SHOP, { overrides: { status } })),
  );
  await testQuote(SHOP, { overrides: { status: "DRAFT" } });
  await testQuote(SHOP, { overrides: { status: "APPROVED" } });
  await testQuote(SHOP, { overrides: { status: "SENT", companyId: COMPANY_B } });

  const quotes = await listCustomerQuotes(SHOP, [COMPANY_A]);
  expect(quotes.map((quote) => quote.id).sort()).toEqual(expect.arrayContaining(visible.map((quote) => quote.id)));
  expect(quotes.every((quote) => ["SENT", "ORDERED", "DECLINED", "EXPIRED"].includes(quote.status))).toBe(true);
  const first = quotes.find((quote) => quote.id === visible[0].id);
  expect(first).toMatchObject({ label: `Q-${visible[0].number}`, currencyCode: "USD" });
  expect(first?.pdfUrl).toMatch(/\/q\/[^/]+\/pdf$/);
  expect(Object.keys(first ?? {})).not.toContain("internalNote");
  expect(Object.keys(first ?? {})).not.toContain("attention");
  expect(JSON.stringify(quotes)).not.toMatch(/unitCost|margin/i); // M10.2: costs never reach the buyer
  expect(await listCustomerQuotes(SHOP, [])).toEqual([]);
});

test("acting on another company's quote is a 404 (scenario 4)", async () => {
  const other = await sentQuote({ companyId: COMPANY_B });
  expect(await statusOf(customerAction(actor, [COMPANY_A], other.id, "decline", "no"))).toBe(404);
  expect((await db.quote.findUniqueOrThrow({ where: { id: other.id } })).status).toBe("SENT");
});

test("decline: DECLINED, draft order deleted, audited as the customer, rep emailed", async () => {
  const quote = await sentQuote({ draftOrderId: "gid://shopify/DraftOrder/9" });
  await customerAction(actor, [COMPANY_A], quote.id, "decline", "  Too expensive  ");

  const after = await db.quote.findUniqueOrThrow({ where: { id: quote.id } });
  expect(after.status).toBe("DECLINED");
  expect(after.syncStatus).toBe("QUEUED");
  expect(jobs("sync-draft-order")).toEqual([{ shop: SHOP, quoteId: quote.id, op: "delete" }]);
  const event = await db.auditEvent.findFirstOrThrow({ where: { shop: SHOP, quoteId: quote.id, action: "quote.declined" } });
  expect(event).toMatchObject({ actorType: "CUSTOMER", actorId: actor.customerId, data: { message: "Too expensive" } });
  expect(jobs("send-email")).toEqual([
    expect.objectContaining({ type: "quoteDeclined", to: "rep@shop.test", params: expect.objectContaining({ comment: "Too expensive" }) }),
  ]);
});

test("request changes: stays SENT, needs attention, rep emailed", async () => {
  const quote = await sentQuote();
  await customerAction(actor, [COMPANY_A], quote.id, "changes", "10 more units please");

  const after = await db.quote.findUniqueOrThrow({ where: { id: quote.id } });
  expect(after.status).toBe("SENT");
  expect(attentionItems(after.attention)).toEqual([
    expect.objectContaining({ code: "CHANGES_REQUESTED", message: "10 more units please" }),
  ]);
  expect(jobs("sync-draft-order")).toEqual([]);
  expect(jobs("send-email")).toContainEqual(expect.objectContaining({ type: "changesRequested", to: "rep@shop.test" }));
});

test("a quote that isn't SENT is a 409; an empty message a 400", async () => {
  const draft = await testQuote(SHOP, { overrides: { status: "DRAFT", assignedToUserId: REP } });
  expect(await statusOf(customerAction(actor, [COMPANY_A], draft.id, "decline", "no"))).toBe(409);
  const sent = await sentQuote();
  expect(await statusOf(customerAction(actor, [COMPANY_A], sent.id, "changes", "   "))).toBe(400);
  expect(enqueueMock).not.toHaveBeenCalled();
});

test("M9.3: the buyer saves a PO number on a SENT quote (no draft order → no Shopify call); listed back", async () => {
  const quote = await sentQuote({ companyId: COMPANY_A });

  await customerSetPoNumber(actor, [COMPANY_A], quote.id, " PO-555 ");

  expect((await db.quote.findUniqueOrThrow({ where: { id: quote.id } })).poNumber).toBe("PO-555");
  const event = await db.auditEvent.findFirstOrThrow({ where: { shop: SHOP, quoteId: quote.id, action: "quote.po_number_set" } });
  expect([event.actorType, event.actorId]).toEqual(["CUSTOMER", "gid://shopify/Customer/1"]);
  expect((await listCustomerQuotes(SHOP, [COMPANY_A])).find((item) => item.id === quote.id)?.poNumber).toBe("PO-555");

  await expect(customerSetPoNumber(actor, [COMPANY_B], quote.id, "PO-1")).rejects.toMatchObject({ status: 404 });
  await db.quote.update({ where: { id: quote.id }, data: { status: "ORDERED" } });
  await expect(customerSetPoNumber(actor, [COMPANY_A], quote.id, "PO-1")).rejects.toMatchObject({ status: 409 });
});

