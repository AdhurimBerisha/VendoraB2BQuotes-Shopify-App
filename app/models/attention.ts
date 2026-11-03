import type { Prisma } from "@prisma/client";

// Things on a quote a human must look at (Quote.attention). M4.2 adds the resolve actions.
type AttentionCode =
  | "SYNC_FAILED"
  | "TAG_COLLISION"
  | "DRAFT_DELETED"
  | "CHANGED_IN_SHOPIFY"
  | "PRODUCT_DELETED"
  | "PRODUCT_NOT_ACTIVE"
  | "PRICE_MISMATCH"
  | "INVOICE_FAILED"
  | "ORDER_ON_CLOSED_QUOTE";
type AttentionItem = {
  code: AttentionCode;
  message?: string;
  data?: Record<string, Prisma.InputJsonValue>;
  at: string;
};

const attentionItems = (current: unknown): AttentionItem[] =>
  Array.isArray(current) ? (current as AttentionItem[]) : [];

// Adds the item, replacing one with the same code (no duplicates).
const withItem = (current: unknown, item: Omit<AttentionItem, "at">): AttentionItem[] => [
  ...attentionItems(current).filter((existing) => existing.code !== item.code),
  { ...item, at: new Date().toISOString() },
];

// Removes the items a successful retry resolved; null when nothing is left.
const withoutItems = (current: unknown, codes: AttentionCode[]): AttentionItem[] | null => {
  const left = attentionItems(current).filter((item) => !codes.includes(item.code));
  return left.length ? left : null;
};

export { attentionItems, withItem, withoutItems };
export type { AttentionCode, AttentionItem };
