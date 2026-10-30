import db from "../db.server";

const customerGid = (id: number) => `gid://shopify/Customer/${id}`;

// Every table that has a `shop` column must be listed here.
// privacy.server.test.ts fails if a new shop-scoped model is added and forgotten.
const redactShop = async (shop: string) => {
  await db.$transaction([
    db.auditEvent.deleteMany({ where: { shop } }),
    db.privacyRequest.deleteMany({ where: { shop } }),
    db.quote.deleteMany({ where: { shop } }), // versions and lines cascade
    db.session.deleteMany({ where: { shop } }),
    db.shop.deleteMany({ where: { id: shop } }),
    db.staffMember.deleteMany({ where: { shop } }),
    db.webhookEvent.deleteMany({ where: { shop } }),
  ]);
};

const redactCustomer = async (shop: string, customerId: number) => {
  const gid = customerGid(customerId);
  await db.$transaction([
    db.quote.updateMany({
      where: { shop, contactCustomerId: gid },
      data: { contactCustomerId: "redacted", companyContactId: "redacted" },
    }),
    db.auditEvent.updateMany({
      where: { shop, actorType: "CUSTOMER", actorId: gid },
      data: { actorId: "redacted" },
    }),
  ]);
};

// Stores the customer's data for the merchant to hand over (download UI: M2.8).
const collectCustomerData = async (shop: string, customerId: number) => {
  const gid = customerGid(customerId);
  const quotes = await db.quote.findMany({
    where: { shop, contactCustomerId: gid },
    include: { versions: { include: { lines: true }, orderBy: { versionNumber: "asc" } } },
  });
  await db.privacyRequest.create({
    data: {
      shop,
      topic: "customers/data_request",
      customerGid: gid,
      result: quotes.map((quote) => ({
        id: quote.id,
        number: quote.number,
        status: quote.status,
        companyId: quote.companyId,
        companyLocationId: quote.companyLocationId,
        companyContactId: quote.companyContactId,
        currencyCode: quote.currencyCode,
        versions: quote.versions.map((version) => ({
          versionNumber: version.versionNumber,
          total: version.total.toString(),
          lines: version.lines.map((line) => ({
            variantId: line.variantId,
            title: line.titleSnapshot,
            quantity: line.quantity,
            lineTotal: line.lineTotal.toString(),
          })),
        })),
        draftOrderId: quote.draftOrderId,
        createdAt: quote.createdAt.toISOString(),
      })),
    },
  });
};

// Shopify sends the customer id as a number; anything else means there's nothing to match.
const payloadCustomerId = (payload: Record<string, unknown>) => {
  const customer = payload.customer as { id?: unknown } | undefined;
  const id = Number(customer?.id);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
};

const handlePrivacyWebhook = async (
  topic: string,
  payload: Record<string, unknown>,
  shop: string,
) => {
  if (topic === "SHOP_REDACT") return redactShop(shop);

  const customerId = payloadCustomerId(payload);
  if (customerId === null) {
    console.warn("privacy webhook without customer id", { topic, shop });
    return;
  }
  if (topic === "CUSTOMERS_REDACT") return redactCustomer(shop, customerId);
  if (topic === "CUSTOMERS_DATA_REQUEST") return collectCustomerData(shop, customerId);
  throw new Error(`Unhandled privacy topic ${topic}`);
};

export { collectCustomerData, handlePrivacyWebhook, redactCustomer, redactShop };
