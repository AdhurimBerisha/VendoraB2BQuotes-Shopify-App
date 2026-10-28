-- PoC quotes (single table, lines as JSON) do not fit the v2 model: dev data only, dropped.
DELETE FROM "Quote";

-- DropIndex
DROP INDEX "Quote_shop_idx";

-- AlterTable
ALTER TABLE "Quote" DROP COLUMN "lastError",
DROP COLUMN "lines",
ADD COLUMN     "assignedToUserId" BIGINT,
ADD COLUMN     "attention" JSONB,
ADD COLUMN     "currencyCode" TEXT NOT NULL,
ADD COLUMN     "currentVersionId" TEXT,
ADD COLUMN     "expiresAt" TIMESTAMP(3),
ADD COLUMN     "invoiceSentVersionId" TEXT,
ADD COLUMN     "lockVersion" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "number" INTEGER NOT NULL,
ADD COLUMN     "orderId" TEXT,
ADD COLUMN     "shopifyUpdatedAt" TIMESTAMP(3),
ADD COLUMN     "syncClaimedAt" TIMESTAMP(3),
ADD COLUMN     "syncError" TEXT,
ADD COLUMN     "syncStatus" TEXT NOT NULL DEFAULT 'NONE',
ADD COLUMN     "syncedVersionId" TEXT;

-- AlterTable
ALTER TABLE "Shop" ADD COLUMN     "approvalRules" JSONB NOT NULL DEFAULT '{"maxDiscountPct":15,"maxTotalByCurrency":{},"alwaysRequire":false,"requireDifferentApprover":true}',
ADD COLUMN     "defaultExpiryDays" INTEGER NOT NULL DEFAULT 30,
ADD COLUMN     "logoUrl" TEXT,
ADD COLUMN     "nextQuoteNumber" INTEGER NOT NULL DEFAULT 1001,
ADD COLUMN     "notifyEmails" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "quotePrefix" TEXT NOT NULL DEFAULT 'Q-',
ADD COLUMN     "quoteTerms" TEXT,
ADD COLUMN     "reserveInventory" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "QuoteVersion" (
    "id" TEXT NOT NULL,
    "quoteId" TEXT NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "quoteDiscountPct" DECIMAL(7,4),
    "listTotal" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "subtotal" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "discountTotal" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "total" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "note" TEXT,
    "internalNote" TEXT,
    "createdByUserId" BIGINT,
    "lockedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QuoteVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuoteLine" (
    "id" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "variantId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "sku" TEXT,
    "titleSnapshot" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "catalogPrice" DECIMAL(14,4) NOT NULL,
    "overridePrice" DECIMAL(14,4),
    "discountPct" DECIMAL(7,4),
    "lineTotal" DECIMAL(14,4) NOT NULL,
    "problems" JSONB,

    CONSTRAINT "QuoteLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "quoteId" TEXT,
    "actorType" TEXT NOT NULL,
    "actorId" TEXT,
    "action" TEXT NOT NULL,
    "data" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "QuoteVersion_quoteId_versionNumber_key" ON "QuoteVersion"("quoteId", "versionNumber");

-- CreateIndex
CREATE INDEX "QuoteLine_variantId_idx" ON "QuoteLine"("variantId");

-- CreateIndex
CREATE INDEX "AuditEvent_shop_quoteId_createdAt_idx" ON "AuditEvent"("shop", "quoteId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Quote_currentVersionId_key" ON "Quote"("currentVersionId");

-- CreateIndex
CREATE INDEX "Quote_shop_status_updatedAt_idx" ON "Quote"("shop", "status", "updatedAt");

-- CreateIndex
CREATE INDEX "Quote_shop_companyId_idx" ON "Quote"("shop", "companyId");

-- CreateIndex
CREATE INDEX "Quote_shop_expiresAt_idx" ON "Quote"("shop", "expiresAt");

-- CreateIndex
CREATE INDEX "Quote_shop_draftOrderId_idx" ON "Quote"("shop", "draftOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "Quote_shop_number_key" ON "Quote"("shop", "number");

-- AddForeignKey
ALTER TABLE "Quote" ADD CONSTRAINT "Quote_currentVersionId_fkey" FOREIGN KEY ("currentVersionId") REFERENCES "QuoteVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuoteVersion" ADD CONSTRAINT "QuoteVersion_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "Quote"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuoteLine" ADD CONSTRAINT "QuoteLine_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "QuoteVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

