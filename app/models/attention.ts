import type { Prisma } from "@prisma/client";

// Things on a quote a human must look at (Quote.attention). Resolve actions: attention.server.ts.
type AttentionCode =
  | "SYNC_FAILED"
  | "TAG_COLLISION"
  | "DRAFT_DELETED"
  | "CHANGED_IN_SHOPIFY"
  | "PRODUCT_DELETED"
  | "PRODUCT_NOT_ACTIVE"
  | "PRICE_MISMATCH"
  | "INVOICE_FAILED"
  | "ORDER_ON_CLOSED_QUOTE"
  | "CHANGES_REQUESTED" // the buyer asked for changes (M3.4); cleared when a new version starts
  | "RETRIES_EXHAUSTED"; // a background sync failed every retry (M4.2)
type AttentionItem = {
  code: AttentionCode;
  message?: string;
  data?: Record<string, Prisma.InputJsonValue>;
  at: string;
};

// What a person can do about each item (M4.2). The first action is the suggested one.
const ATTENTION_ACTIONS = {
  SYNC_FAILED: ["retry"],
  RETRIES_EXHAUSTED: ["retry"],
  // Only a new draft: the tagged ones belong to another company (B-1), so never adopt them.
  TAG_COLLISION: ["createNew"],
  DRAFT_DELETED: ["recreate", "cancel"],
  CHANGED_IN_SHOPIFY: ["overwrite", "acceptShopify"],
  PRODUCT_DELETED: ["editQuote"],
  PRODUCT_NOT_ACTIVE: ["editQuote"],
  PRICE_MISMATCH: ["dismiss"],
  CHANGES_REQUESTED: ["revise"],
  INVOICE_FAILED: ["retrySend"],
  ORDER_ON_CLOSED_QUOTE: ["dismiss"],
} as const satisfies Record<AttentionCode, readonly string[]>;
type AttentionAction = (typeof ATTENTION_ACTIONS)[AttentionCode][number];

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

export { ATTENTION_ACTIONS, attentionItems, withItem, withoutItems };
export type { AttentionAction, AttentionCode, AttentionItem };
