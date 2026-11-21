import { afterAll, beforeAll, expect, test, vi } from "vitest";
import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import db from "../db.server";
import { testQuote, testShop } from "../test/factories";
import { audit } from "../models/audit.server";
import { redactShop } from "../models/privacy.server";
import { runFlowTrigger } from "./flow-trigger.server";
import { enqueue } from "./queue.server";

vi.mock("./queue.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./queue.server")>()),
  enqueue: vi.fn(async () => "job-id"),
  getBoss: vi.fn(async () => ({})),
}));
const enqueueMock = vi.mocked(enqueue);

let SHOP: string;

beforeAll(async () => {
  SHOP = (await testShop({ quotePrefix: "Q-" })).id;
});

afterAll(async () => {
  await redactShop(SHOP);
  await db.$disconnect();
});

// A stand-in admin client that records flowTriggerReceive calls and answers with `userErrors`.
const flowAdmin = (userErrors: { field: string[]; message: string }[] = []) => {
  const sent: { handle: string; payload: Record<string, unknown> }[] = [];
  const admin = {
    graphql: async (query: string, options: { variables: { handle: string; payload: Record<string, unknown> } }) => {
      expect(query).toContain("flowTriggerReceive");
      sent.push(options.variables);
      return Response.json({ data: { flowTriggerReceive: { userErrors } } });
    },
  } as unknown as AdminApiContext;
  return { admin, sent };
};

test("quote events in the history queue their Flow trigger; other events don't", async () => {
  const quote = await testQuote(SHOP);
  const actor = { type: "SYSTEM" as const, shop: SHOP, reason: "test" };
  enqueueMock.mockClear();

  await audit(db, actor, quote.id, "quote.approved");
  await audit(db, actor, quote.id, "quote.lines_saved");
  await audit(db, actor, null, "quote.expired");

  const flow = enqueueMock.mock.calls.filter(([queue]) => queue === "flow-trigger").map(([, data]) => data);
  expect(flow).toEqual([{ shop: SHOP, quoteId: quote.id, handle: "vendora-quote-approved" }]);
});

test("the payload has every trigger field; ordered adds the order", async () => {
  const quote = await testQuote(SHOP, {
    overrides: {
      status: "ORDERED",
      companyId: "gid://shopify/Company/11",
      companyContactId: "gid://shopify/CompanyContact/22",
      currencyCode: "CAD",
      poNumber: "PO-1",
      orderId: "gid://shopify/Order/33",
    },
  });
  const { admin, sent } = flowAdmin();

  await runFlowTrigger({ shop: SHOP, quoteId: quote.id, handle: "vendora-quote-ordered" }, async () => admin);
  await runFlowTrigger({ shop: SHOP, quoteId: quote.id, handle: "vendora-quote-sent" }, async () => admin);

  const [ordered, sentTrigger] = sent;
  expect(ordered.handle).toBe("vendora-quote-ordered");
  expect(ordered.payload).toMatchObject({
    company_id: 11,
    company_contact_id: 22,
    "Quote number": `Q-${quote.number}`,
    Currency: "CAD",
    "PO number": "PO-1",
    order_id: 33,
  });
  expect(ordered.payload["Quote URL"]).toMatch(new RegExp(`^https://${SHOP}/admin/apps/.*/app/quotes/${quote.id}$`));
  expect(typeof ordered.payload.Total).toBe("number");
  expect(sentTrigger.payload).not.toHaveProperty("order_id");
});

test("Shopify's userErrors are logged, not retried; a gone quote is skipped", async () => {
  const quote = await testQuote(SHOP);
  const { admin, sent } = flowAdmin([{ field: ["handle"], message: "Invalid handle" }]);

  await expect(
    runFlowTrigger({ shop: SHOP, quoteId: quote.id, handle: "vendora-quote-approved" }, async () => admin),
  ).resolves.toBeUndefined();
  await runFlowTrigger({ shop: SHOP, quoteId: "missing", handle: "vendora-quote-approved" }, async () => admin);
  expect(sent).toHaveLength(1);
});
