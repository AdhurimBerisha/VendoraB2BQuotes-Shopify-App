import type { Quote } from "@prisma/client";
import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import db from "../db.server";

type Line = { variantId: string; quantity: number };

// ponytail: draftOrderCreate has no @idempotent support, so a crashed attempt is only
// reclaimed after STALE_MS and found again by tag. Relies on Shopify's draft-order search
// index catching up within this window; switch to @idempotent if Shopify adds it.
export const STALE_MS = 2 * 60_000;

export const quoteTag = (quoteId: string) => `vendora-quote-${quoteId}`;

export async function createQuote(
  admin: AdminApiContext,
  shop: string,
  input: { locationId: unknown; variantId: unknown; quantity: unknown },
) {
  const { locationId, variantId } = input;
  const quantity = Number(input.quantity);
  if (
    typeof locationId !== "string" ||
    !locationId.startsWith("gid://shopify/CompanyLocation/") ||
    typeof variantId !== "string" ||
    !variantId.startsWith("gid://shopify/ProductVariant/") ||
    !Number.isInteger(quantity) ||
    quantity < 1 ||
    quantity > 10_000
  ) {
    throw new Error("Invalid quote input");
  }

  // Derive company + contact from Shopify instead of trusting the client.
  const response = await admin.graphql(
    `#graphql
    query VendoraQuoteCompanyLocation($id: ID!) {
      companyLocation(id: $id) {
        id
        company { id mainContact { id } }
      }
    }`,
    { variables: { id: locationId } },
  );
  const { data } = await response.json();
  const company = data?.companyLocation?.company;
  if (!company) throw new Error("Company location not found");
  if (!company.mainContact) {
    throw new Error(
      "This company has no main contact. Set one in Shopify admin → Customers → Companies.",
    );
  }

  const lines: Line[] = [{ variantId, quantity }];
  return db.quote.create({
    data: {
      shop,
      companyId: company.id,
      companyLocationId: locationId,
      companyContactId: company.mainContact.id,
      lines,
    },
  });
}

export async function convertQuote(
  admin: AdminApiContext,
  shop: string,
  quoteId: string,
) {
  // Atomic claim: only one caller moves the quote into CONVERTING.
  const now = new Date();
  const { count } = await db.quote.updateMany({
    where: {
      id: quoteId,
      shop,
      OR: [
        { status: { in: ["DRAFT", "FAILED"] } },
        {
          status: "CONVERTING",
          updatedAt: { lt: new Date(now.getTime() - STALE_MS) },
        },
      ],
    },
    data: { status: "CONVERTING", updatedAt: now, lastError: null },
  });
  const quote = await db.quote.findFirstOrThrow({ where: { id: quoteId, shop } });
  if (count === 0) return quote; // already converted or another attempt is in flight

  let draftOrderId: string;
  try {
    draftOrderId =
      (await findDraftOrderId(admin, quote.id)) ??
      (await createDraftOrder(admin, quote));
  } catch (error) {
    if (error instanceof DraftOrderUserErrors) {
      // Shopify rejected the input, so nothing was created: safe to retry right away.
      return db.quote.update({
        where: { id: quote.id },
        data: { status: "FAILED", lastError: error.message },
      });
    }
    // Ambiguous (network, timeout, 5xx): Shopify may have created it. Stay CONVERTING
    // so only a stale reclaim retries, and that retry finds the order by tag.
    throw error;
  }

  return db.quote.update({
    where: { id: quote.id },
    data: { status: "CONVERTED", draftOrderId },
  });
}

class DraftOrderUserErrors extends Error {}

async function findDraftOrderId(admin: AdminApiContext, quoteId: string) {
  const response = await admin.graphql(
    `#graphql
    query VendoraQuoteDraftOrderByTag($query: String!) {
      draftOrders(first: 1, query: $query) {
        nodes { id }
      }
    }`,
    { variables: { query: `tag:'${quoteTag(quoteId)}'` } },
  );
  const { data } = await response.json();
  return data?.draftOrders.nodes[0]?.id ?? null;
}

async function createDraftOrder(admin: AdminApiContext, quote: Quote) {
  const response = await admin.graphql(
    `#graphql
    mutation VendoraQuoteDraftOrderCreate($input: DraftOrderInput!) {
      draftOrderCreate(input: $input) {
        draftOrder { id }
        userErrors { field message }
      }
    }`,
    {
      variables: {
        input: {
          purchasingEntity: {
            purchasingCompany: {
              companyId: quote.companyId,
              companyLocationId: quote.companyLocationId,
              companyContactId: quote.companyContactId,
            },
          },
          lineItems: quote.lines as Line[],
          tags: [quoteTag(quote.id)],
        },
      },
    },
  );
  const { data } = await response.json();
  const result = data?.draftOrderCreate;
  if (result?.userErrors?.length) {
    throw new DraftOrderUserErrors(
      result.userErrors.map((e) => e.message).join("; "),
    );
  }
  if (!result?.draftOrder) throw new Error("draftOrderCreate returned no draft order");
  return result.draftOrder.id;
}
