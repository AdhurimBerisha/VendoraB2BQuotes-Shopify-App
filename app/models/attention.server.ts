import type { Prisma } from "@prisma/client";
import { type AttentionItem, attentionItems, withItem } from "./attention";
import { notify } from "./notify.server";

// Adds an attention item. When a quote first needs attention, managers get one email;
// more items on the same quote don't send more until it is clear again.
const raise = async (
  tx: Prisma.TransactionClient,
  shop: string,
  quoteId: string,
  item: Omit<AttentionItem, "at">,
) => {
  const quote = await tx.quote.findFirstOrThrow({ where: { id: quoteId, shop }, select: { attention: true } });
  await tx.quote.update({ where: { id: quoteId }, data: { attention: withItem(quote.attention, item) } });
  if (attentionItems(quote.attention).length === 0) {
    await notify(tx, shop, "needsAttention", { kind: "managers" }, { quoteId });
  }
  console.log("attention raised", { shop, quoteId, code: item.code });
};

export { raise };
