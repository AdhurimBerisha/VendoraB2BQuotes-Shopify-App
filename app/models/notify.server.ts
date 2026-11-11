import { logger } from "../lib/logger.server";
import type { Prisma } from "@prisma/client";
import db from "../db.server";
import type { EmailParams, EmailType } from "../emails/templates";
import { enqueue } from "../jobs/queue.server";

type Tx = Prisma.TransactionClient | typeof db;
type Audience = { kind: "managers"; except?: bigint | null } | { kind: "user"; userId: bigint | null };
type SendEmailJob = { shop: string; type: EmailType; to: string; locale: string; params: EmailParams };

const isOn = (prefs: unknown, type: EmailType) =>
  typeof prefs !== "object" || prefs === null || (prefs as Record<string, unknown>)[type] !== false;

// Opens the embedded app at that page (admin.shopify.com/store/<handle>/apps/<client id>/<path>).
const adminUrl = (shop: string, path: string) =>
  `https://admin.shopify.com/store/${shop.replace(/\.myshopify\.com$/, "")}/apps/${process.env.SHOPIFY_API_KEY ?? ""}${path}`;

// Queues one send-email job per recipient. Pass the transaction of the change it reports
// (the jobs commit with it); start pg-boss before opening that transaction (see enqueue).
// Nobody to tell is not an error.
const notify = async (
  tx: Tx,
  shop: string,
  type: EmailType,
  audience: Audience,
  params: { quoteId: string } & Pick<EmailParams, "actor" | "comment" | "reasons" | "date">,
) => {
  if (audience.kind === "user" && audience.userId === null) return;
  const { quoteId, ...rest } = params;
  const [quote, shopRow, staff] = await Promise.all([
    tx.quote.findFirst({ where: { id: quoteId, shop }, select: { number: true } }),
    tx.shop.findUnique({ where: { id: shop } }),
    tx.staffMember.findMany({
      where: {
        shop,
        email: { not: null },
        ...(audience.kind === "managers"
          ? { role: { in: ["OWNER", "MANAGER"] }, ...(audience.except ? { shopifyUserId: { not: audience.except } } : {}) }
          : { shopifyUserId: audience.userId ?? undefined }),
      },
      select: { email: true, locale: true, notificationPrefs: true },
    }),
  ]);
  if (!quote || !shopRow) return;

  const recipients = staff
    .filter((member) => isOn(member.notificationPrefs, type))
    .map((member) => ({ to: member.email ?? "", locale: member.locale }));
  // The shop-wide list (Settings → General) also hears about orders.
  if (type === "quoteOrdered") recipients.push(...shopRow.notifyEmails.map((to) => ({ to, locale: "en" })));

  const emailParams: EmailParams = {
    ...rest,
    quoteLabel: `${shopRow.quotePrefix}${quote.number}`,
    shopName: shopRow.name ?? shop,
    url: adminUrl(shop, `/app/quotes/${quoteId}`),
  };
  const unique = [...new Map(recipients.map((recipient) => [recipient.to.toLowerCase(), recipient])).values()];
  for (const { to, locale } of unique) {
    const job: SendEmailJob = { shop, type, to, locale, params: emailParams };
    await enqueue("send-email", job, { tx });
  }
  logger.info({ shop, quoteId, type, recipients: unique.length }, "notify queued");
};

export { adminUrl, notify };
export type { SendEmailJob };
