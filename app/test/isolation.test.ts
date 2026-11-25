import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import db from "../db.server";
import { ForbiddenError, NotFoundError } from "../lib/errors";
import type { CustomerActor } from "../models/actor";
import { parseRules } from "../models/approval";
import { decide, saveApprovalRules, submitQuote } from "../models/approval.server";
import { resolveAttention } from "../models/attention-actions.server";
import { audit, quoteHistory } from "../models/audit.server";
import { customerAction, customerSetPoNumber, listCustomerQuotes } from "../models/customer-quotes.server";
import { commitImport, startImport } from "../models/import.server";
import { listFailedJobs, retryFailedJob } from "../models/jobs.server";
import { loadQuotePdfData } from "../models/pdf.server";
import { redactCustomer, redactShop } from "../models/privacy.server";
import {
  cancelQuote,
  createQuote,
  expireQuote,
  getQuote,
  listQuotes,
  savePaymentTerms,
  setExpiry,
  setPoNumber,
  transition,
} from "../models/quote.server";
import { saveBranding, saveGeneralSettings } from "../models/shop.server";
import { setRole } from "../models/staff.server";
import { giveUpInvoice, giveUpSync, requestSync, sendQuote } from "../models/sync.server";
import { duplicateQuote, refreshPrices, reviseQuote, saveDraftLines } from "../models/version.server";
import { processWebhook } from "../models/webhooks.server";
import { staff, testQuote, testShop } from "./factories";
import { fakeShopify } from "./fake-shopify";

// M4.5: tenant isolation. Shop B's actor with shop A's ids → an error, and shop A's data unchanged.
// MODEL_FUNCTIONS lists every exported model function and where its isolation is tested:
// a new export without an entry fails the last test.

vi.mock("../jobs/queue.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../jobs/queue.server")>()),
  enqueue: vi.fn(async () => "job-id"),
  getBoss: vi.fn(async () => undefined),
}));

const HERE = "isolation.test.ts";
const NA = (reason: string) => `n/a: ${reason}`;
const MODEL_FUNCTIONS: Record<string, string> = {
  "actor.getActor": NA("shop from the admin session"),
  "approval.decide": HERE,
  "approval.saveApprovalRules": NA("own shop only, no id"),
  "approval.submitQuote": HERE,
  "attention-actions.parseLinesKey": NA("pure"),
  "attention-actions.resolveAttention": HERE,
  "attention.raise": NA("internal; findFirstOrThrow by id + shop"),
  "audit.audit": NA("writes the actor's shop"),
  "audit.quoteHistory": HERE,
  "customer-quotes.authenticateCustomer": NA("shop from the verified session token"),
  "customer-quotes.customerAction": HERE,
  "customer-quotes.customerSetPoNumber": HERE,
  "customer-quotes.listCustomerQuotes": HERE,
  "customer-quotes.shopFromDest": NA("pure"),
  "flow.queueFlowTrigger": NA("called by audit() with the acting shop, inside its transaction"),
  "health.isDegraded": NA("process-wide, no shop data"),
  "health.recordHealth": NA("process-wide, no shop data"),
  "health.resetHealth": NA("process-wide, no shop data"),
  "import.commitImport": "import.server.test.ts",
  "import.parseCsv": NA("pure"),
  "import.reportToCsv": NA("pure"),
  "import.runValidation": NA("job; import id from our own job data"),
  "import.startImport": HERE,
  "import.validateRows": NA("pure"),
  "jobs.listFailedJobs": "jobs.server.test.ts",
  "jobs.retryFailedJob": "jobs.server.test.ts",
  "notify.adminUrl": NA("pure"),
  "notify.notify": "notify.server.test.ts",
  "shop.assertB2b": NA("own shop only, no id"),
  "shop.checkB2b": NA("own shop's admin client; writes the shop it is given"),
  "shop.missingScopes": NA("pure"),
  "shop.orB2bLost": NA("writes the shop it is given"),
  "shop.takeWelcomeBack": NA("own shop only, no id"),
  "onboarding.advance": NA("own shop only, no id"),
  "onboarding.connectionTest": NA("own shop's admin client, no stored data"),
  "onboarding.finishOnboarding": NA("own shop only, no id"),
  "onboarding.runEligibility": NA("own shop's admin client, no stored data"),
  "pdf.loadQuotePdfData": HERE,
  "pdf.renderQuotePdf": NA("pure"),
  "privacy.collectCustomerData": NA("where { shop } only; webhook HMAC gives the shop"),
  "privacy.handlePrivacyWebhook": "privacy.server.test.ts",
  "privacy.redactCustomer": HERE,
  "privacy.redactShop": "privacy.server.test.ts",
  "public-quote.acceptPublicQuote": "routes/q.$token/route.test.ts",
  "public-quote.findPublicQuote": "routes/q.$token/route.test.ts",
  "public-quote.notFound": NA("pure"),
  "public-quote.recordView": NA("takes a quote already found by findPublicQuote"),
  "quote-request.createRequestedQuote": NA("creates; location checked against the buyer in Shopify"),
  "quote-request.requestQuoteFromStorefront": "quote-request.server.test.ts",
  "quote.cancelQuote": HERE,
  "quote.createQuote": NA("creates; location read with the shop's own admin client"),
  "quote.expireQuote": HERE,
  "quote.getQuote": HERE,
  "quote.insertQuote": NA("internal; creates"),
  "quote.quoteFields": NA("reads Shopify with the shop's own admin client"),
  "quote.listQuotes": HERE,
  "quote.locationTerms": NA("pure"),
  "quote.savePaymentTerms": HERE,
  "quote.quoteLabel": NA("pure"),
  "quote.quoteWhere": NA("pure; always sets shop"),
  "quote.searchFilters": NA("Shopify search with the shop's own admin client"),
  "quote.savePoNumber": NA("internal; every caller checks access first"),
  "quote.setExpiry": HERE,
  "quote.setPoNumber": HERE,
  "quote.transition": HERE,
  "shop.brandingFromForm": NA("pure"),
  "shop.generalSettingsFromForm": NA("pure"),
  "shop.getShop": NA("by the session's shop"),
  "shop.isAllowedLogoUrl": NA("pure"),
  "shop.isInstalled": NA("by the given shop"),
  "shop.markUninstalled": NA("webhook HMAC gives the shop"),
  "shop.saveBranding": NA("own shop only, no id"),
  "shop.saveGeneralSettings": NA("own shop only, no id"),
  "shop.updateShopFromWebhook": NA("webhook HMAC gives the shop"),
  "shop.upsertShopOnInstall": NA("OAuth gives the shop"),
  "staff.getNotificationPrefs": NA("own staff row"),
  "staff.listStaff": NA("where { shop } only"),
  "staff.notificationPrefsFromForm": NA("pure"),
  "staff.saveNotificationPrefs": NA("own staff row"),
  "staff.setRole": "staff.server.test.ts",
  "staff.upsertStaffFromSession": NA("shop from the admin session"),
  "sync.SyncInFlight": NA("error class"),
  "sync.giveUpInvoice": HERE,
  "sync.giveUpSync": HERE,
  "sync.requestSync": HERE,
  "sync.runSendInvoice": NA("job; shop from our own job data"),
  "sync.runSync": "sync.server.test.ts",
  "sync.sendQuote": HERE,
  "version.diffVersions": NA("pure"),
  "version.duplicateQuote": HERE,
  "version.lineProblems": NA("pure"),
  "version.lineRows": NA("pure"),
  "version.priceLines": NA("Shopify prices with the shop's own admin client"),
  "version.refreshPrices": HERE,
  "version.reviseQuote": HERE,
  "version.saveDraftLines": HERE,
  "version.toLineInput": NA("pure"),
  "webhook-events.forgetWebhook": NA("keyed by Shopify's webhook id"),
  "webhook-events.markWebhookProcessed": NA("keyed by Shopify's webhook id"),
  "webhook-events.recordWebhookOnce": NA("keyed by Shopify's webhook id"),
  "webhooks.processWebhook": HERE,
};

const shopify = fakeShopify();
let SHOP_A: string;
let SHOP_B: string;
let QUOTE_A: string;
const DRAFT_ORDER = 9_001;

const actorB = () => staff(SHOP_B, shopify.admin, "OWNER");
const viewerA = () => staff(SHOP_A, shopify.admin, "VIEWER", 7n);

// Everything a cross-shop call could change on quote A.
const snapshot = () =>
  db.quote.findUniqueOrThrow({
    where: { id: QUOTE_A },
    select: {
      status: true,
      lockVersion: true,
      syncStatus: true,
      attention: true,
      expiresAt: true,
      currentVersionId: true,
      contactCustomerId: true,
      shopifyUpdatedAt: true,
      updatedAt: true,
    },
  });

beforeAll(async () => {
  SHOP_A = (await testShop()).id;
  SHOP_B = (await testShop()).id;
  const quote = await testQuote(SHOP_A, {
    overrides: {
      status: "PENDING_APPROVAL",
      syncStatus: "QUEUED",
      draftOrderId: `gid://shopify/DraftOrder/${DRAFT_ORDER}`,
      expiresAt: new Date("2099-01-01T00:00:00Z"),
      attention: [{ code: "PRICE_MISMATCH", at: new Date().toISOString() }],
    },
  });
  QUOTE_A = quote.id;
  await audit(db, { type: "SYSTEM", shop: SHOP_A, reason: "test" }, QUOTE_A, "test.event", {});
});

afterAll(async () => {
  await redactShop(SHOP_A);
  await redactShop(SHOP_B);
  await db.$disconnect();
});

describe("shop B can't touch shop A's quote", () => {
  const csv = () => new File(["sku,quantity\nSKU-1,1\n"], "lines.csv", { type: "text/csv" });
  const customerB: () => CustomerActor = () => ({ type: "CUSTOMER", shop: SHOP_B, customerId: "gid://shopify/Customer/1" });

  // Every call must fail; NotFoundError where the function looks the quote up first.
  const rejected: [string, () => Promise<unknown>, new (...args: never[]) => Error][] = [
    ["getQuote", () => getQuote(SHOP_B, QUOTE_A), NotFoundError],
    ["cancelQuote", () => cancelQuote(actorB(), QUOTE_A), NotFoundError],
    ["setExpiry", () => setExpiry(actorB(), QUOTE_A, "2099-06-01"), Error],
    ["setPoNumber", () => setPoNumber(actorB(), QUOTE_A, "PO-B"), NotFoundError],
    ["savePaymentTerms", () => savePaymentTerms(actorB(), QUOTE_A, { templateId: null, depositPct: null }), NotFoundError],
    ["transition", () => db.$transaction((tx) => transition(tx, SHOP_B, QUOTE_A, "cancel", "CANCELLED")), Error],
    ["submitQuote", () => submitQuote(actorB(), QUOTE_A), NotFoundError],
    ["decide", () => decide(actorB(), QUOTE_A, "APPROVED"), NotFoundError],
    ["saveDraftLines", () => saveDraftLines(actorB(), QUOTE_A, 0, [], null), NotFoundError],
    ["refreshPrices", () => refreshPrices(actorB(), QUOTE_A), NotFoundError],
    ["reviseQuote", () => reviseQuote(actorB(), QUOTE_A), NotFoundError],
    ["duplicateQuote", () => duplicateQuote(actorB(), QUOTE_A), NotFoundError],
    ["requestSync", () => requestSync(actorB(), QUOTE_A), Error],
    ["sendQuote", () => sendQuote(actorB(), QUOTE_A, ""), NotFoundError],
    ["resolveAttention", () => resolveAttention(actorB(), QUOTE_A, "PRICE_MISMATCH", "dismiss"), NotFoundError],
    ["startImport", () => startImport(actorB(), QUOTE_A, csv()), NotFoundError],
    ["loadQuotePdfData", () => loadQuotePdfData(shopify.admin, SHOP_B, QUOTE_A), NotFoundError],
    ["customerAction", () => customerAction(customerB(), ["gid://shopify/Company/1"], QUOTE_A, "decline", "no"), NotFoundError],
    ["customerSetPoNumber", () => customerSetPoNumber(customerB(), ["gid://shopify/Company/1"], QUOTE_A, "PO-B"), NotFoundError],
  ];

  test.each(rejected)("%s is refused", async (_name, call, error) => {
    const before = await snapshot();
    await expect(call()).rejects.toBeInstanceOf(error);
    expect(await snapshot()).toEqual(before);
  });

  // Functions that quietly do nothing for an id they don't own.
  const ignored: [string, () => Promise<unknown>][] = [
    ["expireQuote", () => expireQuote(SHOP_B, QUOTE_A, new Date("2100-01-01"))],
    ["giveUpSync", () => giveUpSync(SHOP_B, QUOTE_A, "boom")],
    ["giveUpInvoice", () => giveUpInvoice({ shop: SHOP_B, quoteId: QUOTE_A, versionId: "x", message: "" }, "boom")],
    ["redactCustomer", () => redactCustomer(SHOP_B, 1)],
    [
      "processWebhook update",
      () =>
        processWebhook("DRAFT_ORDERS_UPDATE", SHOP_B, {
          id: DRAFT_ORDER,
          status: "completed",
          order_id: 1,
          updated_at: new Date().toISOString(),
          line_items: [],
        }),
    ],
    ["processWebhook delete", () => processWebhook("DRAFT_ORDERS_DELETE", SHOP_B, { id: DRAFT_ORDER })],
  ];

  test.each(ignored)("%s changes nothing", async (_name, call) => {
    const before = await snapshot();
    await call();
    expect(await snapshot()).toEqual(before);
  });

  test("lists and history of shop B don't show shop A's quote", async () => {
    expect((await listQuotes(SHOP_B)).quotes).toEqual([]);
    expect(await quoteHistory(SHOP_B, QUOTE_A)).toEqual([]);
    expect(await listCustomerQuotes(SHOP_B, ["gid://shopify/Company/1"])).toEqual([]);
    // …while shop A sees them (the setup is right).
    expect((await listQuotes(SHOP_A)).quotes.map((quote) => quote.id)).toEqual([QUOTE_A]);
    expect(await quoteHistory(SHOP_A, QUOTE_A)).toHaveLength(1);
  });
});

test("a VIEWER can't call any function that changes data", async () => {
  const viewer = viewerA();
  const calls: [string, () => Promise<unknown>][] = [
    ["createQuote", () => createQuote(viewer, { locationId: "gid://shopify/CompanyLocation/1" })],
    ["cancelQuote", () => cancelQuote(viewer, QUOTE_A)],
    ["setExpiry", () => setExpiry(viewer, QUOTE_A, "2099-06-01")],
    ["setPoNumber", () => setPoNumber(viewer, QUOTE_A, "PO-V")],
    ["savePaymentTerms", () => savePaymentTerms(viewer, QUOTE_A, { templateId: null, depositPct: null })],
    ["submitQuote", () => submitQuote(viewer, QUOTE_A)],
    ["decide", () => decide(viewer, QUOTE_A, "APPROVED")],
    ["saveApprovalRules", () => saveApprovalRules(viewer, parseRules(null))],
    ["saveDraftLines", () => saveDraftLines(viewer, QUOTE_A, 0, [], null)],
    ["reviseQuote", () => reviseQuote(viewer, QUOTE_A)],
    ["duplicateQuote", () => duplicateQuote(viewer, QUOTE_A)],
    ["requestSync", () => requestSync(viewer, QUOTE_A)],
    ["sendQuote", () => sendQuote(viewer, QUOTE_A, "")],
    ["resolveAttention", () => resolveAttention(viewer, QUOTE_A, "PRICE_MISMATCH", "dismiss")],
    ["startImport", () => startImport(viewer, QUOTE_A, new File(["sku,quantity\n"], "a.csv"))],
    ["commitImport", () => commitImport(viewer, "any", "append")],
    ["setRole", () => setRole(viewer, "any", "OWNER")],
    [
      "saveGeneralSettings",
      () =>
        saveGeneralSettings(viewer, {
          quotePrefix: "Q-",
          nextQuoteNumber: 1,
          defaultExpiryDays: 30,
          followUpNotViewedDays: null,
          followUpNotOrderedDays: null,
          reserveInventory: false,
          importSubmittedDrafts: false,
          notifyEmails: [],
        }),
    ],
    ["saveBranding", () => saveBranding(viewer, { logoUrl: null, quoteTerms: null, quoteFooter: null })],
    ["listFailedJobs", () => listFailedJobs(viewer)],
    ["retryFailedJob", () => retryFailedJob(viewer, "sync-draft-order", "any")],
  ];
  const before = await snapshot();
  for (const [name, call] of calls) {
    await expect(call(), name).rejects.toBeInstanceOf(ForbiddenError);
  }
  expect(await snapshot()).toEqual(before);
});

test("every exported model function has an isolation entry", () => {
  const modules = import.meta.glob<Record<string, unknown>>("../models/*.server.{ts,tsx}", { eager: true });
  const exported = Object.entries(modules).flatMap(([path, mod]) => {
    const file = (path.split("/").pop() ?? "").replace(/\.server\.tsx?$/, "");
    return Object.entries(mod)
      .filter(([, value]) => typeof value === "function")
      .map(([name]) => `${file}.${name}`);
  });
  expect(exported.filter((key) => !(key in MODEL_FUNCTIONS)), "add these to MODEL_FUNCTIONS").toEqual([]);
  expect(Object.keys(MODEL_FUNCTIONS).filter((key) => !exported.includes(key)), "stale entries").toEqual([]);
});
