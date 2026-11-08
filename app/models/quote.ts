// Shared with the browser (the quote list's status filter); server logic lives in quote.server.ts.
const QUOTE_STATUSES = [
  "DRAFT",
  "PENDING_APPROVAL",
  "APPROVED",
  "SENT",
  "ORDERED",
  "DECLINED",
  "EXPIRED",
  "CANCELLED",
] as const;
type QuoteStatus = (typeof QUOTE_STATUSES)[number];

export { QUOTE_STATUSES };
export type { QuoteStatus };
