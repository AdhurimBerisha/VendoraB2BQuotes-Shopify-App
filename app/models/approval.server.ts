import { logger } from "../lib/logger.server";
import db from "../db.server";
import { ConflictError, ForbiddenError, NotFoundError, UserError } from "../lib/errors";
import type { StaffActor } from "./actor";
import { type ApprovalRules, approvalReasons, approvalRulesSchema, parseRules } from "./approval";
import { audit } from "./audit.server";
import { notify } from "./notify.server";
import { requirePermission } from "./permissions";
import { BLOCKING, type LineProblem, discountPctOf } from "./pricing";
import { transition } from "./quote.server";
import { refreshPrices } from "./version.server";

const hasBlockingProblem = (problems: unknown) =>
  Array.isArray(problems) && problems.some((problem) => BLOCKING.includes(problem as LineProblem));

// DRAFT → lock the version → APPROVED (no rule hit) or PENDING_APPROVAL with an Approval row.
const submitQuote = async (actor: StaffActor, quoteId: string) => {
  requirePermission(actor, "quote.submit");
  await refreshPrices(actor, quoteId); // throws quote.errors.pricesChanged if catalog prices moved

  const result = await db.$transaction(async (tx) => {
    // Lock the quote row first (M4.4): a save in flight finishes before we read its lines, and a
    // save sent later from an already-open page gets changedByOther instead of editing a locked version.
    await tx.quote.updateMany({ where: { id: quoteId, shop: actor.shop }, data: { lockVersion: { increment: 1 } } });
    const quote = await tx.quote.findFirst({
      where: { id: quoteId, shop: actor.shop },
      include: { currentVersion: { include: { lines: true } } },
    });
    const version = quote?.currentVersion;
    if (!quote || !version) throw new NotFoundError();
    if (version.lines.length === 0) throw new UserError("quote.errors.noLines");
    if (version.lines.some((line) => hasBlockingProblem(line.problems))) {
      throw new UserError("quote.errors.blockingProblems");
    }

    const shop = await tx.shop.findUniqueOrThrow({ where: { id: actor.shop } });
    const reasons = approvalReasons(
      { effectiveDiscountPct: discountPctOf(version.listTotal, version.discountTotal), total: version.total },
      parseRules(shop.approvalRules),
      quote.currencyCode,
    );

    // The status change is the atomic step: of two submits at once, only one gets past it.
    const needsApproval = reasons.length > 0;
    await transition(tx, actor.shop, quoteId, "submit", needsApproval ? "PENDING_APPROVAL" : "APPROVED");
    await tx.quoteVersion.update({ where: { id: version.id }, data: { lockedAt: new Date() } });
    if (needsApproval) {
      await tx.approval.create({ data: { versionId: version.id, reasons, requestedBy: actor.userId } });
      await audit(tx, actor, quoteId, "quote.submitted", { version: version.versionNumber, reasons });
    } else {
      await audit(tx, actor, quoteId, "quote.approved", { version: version.versionNumber, auto: true });
    }
    return { needsApproval, reasons };
  });
  logger.info({ shop: actor.shop, quoteId, ...result }, "quote submitted");
  if (result.needsApproval) {
    await notify(db, actor.shop, "approvalNeeded", { kind: "managers", except: actor.userId }, {
      quoteId,
      actor: actor.name,
      reasons: result.reasons,
    });
  }
  return result;
};

// PENDING_APPROVAL → APPROVED, or → DRAFT on reject (comment required).
const decide = async (
  actor: StaffActor,
  quoteId: string,
  decision: "APPROVED" | "REJECTED",
  comment?: string,
) => {
  requirePermission(actor, "quote.approve");
  const trimmed = comment?.trim() || null;
  if (decision === "REJECTED" && !trimmed) throw new UserError("approval.errors.commentRequired");

  const requestedBy = await db.$transaction(async (tx) => {
    const quote = await tx.quote.findFirst({ where: { id: quoteId, shop: actor.shop } });
    if (!quote?.currentVersionId) throw new NotFoundError();
    const approval = await tx.approval.findFirst({
      where: { versionId: quote.currentVersionId, decision: null },
      orderBy: { createdAt: "desc" },
    });
    if (!approval) throw new ConflictError("approval.errors.nothingPending");
    const shop = await tx.shop.findUniqueOrThrow({ where: { id: actor.shop } });
    if (parseRules(shop.approvalRules).requireDifferentApprover && approval.requestedBy === actor.userId) {
      throw new ForbiddenError("approval.errors.selfApproval");
    }

    if (decision === "APPROVED") {
      await transition(tx, actor.shop, quoteId, "approve", "APPROVED");
      await audit(tx, actor, quoteId, "quote.approved", { comment: trimmed });
    } else {
      // Rejected: back to DRAFT, and the same version unlocks for editing. It was never
      // approved or sent; approved or sent versions are never unlocked.
      await transition(tx, actor.shop, quoteId, "reject", "DRAFT");
      await tx.quoteVersion.update({ where: { id: quote.currentVersionId }, data: { lockedAt: null } });
      await audit(tx, actor, quoteId, "quote.rejected", { comment: trimmed });
    }
    await tx.approval.update({
      where: { id: approval.id },
      data: { decision, decidedBy: actor.userId, comment: trimmed, decidedAt: new Date() },
    });
    return approval.requestedBy;
  });
  logger.info({ shop: actor.shop, quoteId, decision }, "approval decided");
  await notify(db, actor.shop, decision === "APPROVED" ? "approved" : "rejected", { kind: "user", userId: requestedBy }, {
    quoteId,
    actor: actor.name,
    comment: trimmed ?? undefined,
  });
};

// Settings → Approval rules.
const saveApprovalRules = async (actor: StaffActor, input: ApprovalRules) => {
  requirePermission(actor, "settings.manage");
  const rules = approvalRulesSchema.parse(input);
  await db.$transaction(async (tx) => {
    await tx.shop.update({ where: { id: actor.shop }, data: { approvalRules: rules } });
    await audit(tx, actor, null, "settings.approval_rules_changed", rules);
  });
};

export { decide, saveApprovalRules, submitQuote };
