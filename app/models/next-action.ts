import { localDaysBetween } from "../lib/dates";
import { attentionItems } from "./attention";

// M10.5: what happens next on a quote and who does it, for the quote list. Worked out from
// data we already have (status, attention, pending approval, expiry, M10.3 view events).
type NextAction =
  | { code: "attention" }
  | { code: "yourApproval" }
  | { code: "waitingApproval" }
  | { code: "readyToSend" }
  | { code: "expires"; days: number } // shop-local days, 0 = today
  | { code: "viewed"; days: number } // days since the buyer last opened it
  | { code: "notOpened" };

type NextActionInput = {
  status: string; // Quote.status (QuoteStatus)
  attention: unknown; // Quote.attention JSON
  expiresAt: Date | null;
  lastSentAt: Date | null;
  lastViewedAt: Date | null;
  approvalRequestedBy: bigint | null; // the pending approval's requester
};

type Viewer = { userId: bigint | null; canApprove: boolean; requireDifferentApprover: boolean };

const EXPIRES_SOON_DAYS = 3;

// The most urgent one wins: attention, then approval, then sending, then the buyer's side.
const nextAction = (quote: NextActionInput, viewer: Viewer, timeZone: string, now = new Date()): NextAction | null => {
  if (attentionItems(quote.attention).length > 0) return { code: "attention" };
  if (quote.status === "PENDING_APPROVAL") {
    const ownRequest = viewer.requireDifferentApprover && quote.approvalRequestedBy === viewer.userId;
    return viewer.canApprove && !ownRequest ? { code: "yourApproval" } : { code: "waitingApproval" };
  }
  if (quote.status === "APPROVED") return { code: "readyToSend" };
  if (quote.status !== "SENT") return null;

  if (quote.expiresAt) {
    const days = localDaysBetween(now, quote.expiresAt, timeZone);
    if (days >= 0 && days <= EXPIRES_SOON_DAYS) return { code: "expires", days };
  }
  // Same rule as the quote page: a view before the last send doesn't count.
  const viewedSinceSend = quote.lastViewedAt && (!quote.lastSentAt || quote.lastViewedAt >= quote.lastSentAt);
  if (viewedSinceSend) return { code: "viewed", days: localDaysBetween(quote.lastViewedAt!, now, timeZone) };
  return { code: "notOpened" };
};

export { nextAction };
export type { NextAction, NextActionInput };
