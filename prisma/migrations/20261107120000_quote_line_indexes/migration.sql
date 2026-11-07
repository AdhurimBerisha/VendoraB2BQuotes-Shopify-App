-- M4.6: lines are read by version (every quote page, PDF, sync) and by product (product webhooks).
-- No query filters lines by variantId.

-- DropIndex
DROP INDEX "QuoteLine_variantId_idx";

-- CreateIndex
CREATE INDEX "QuoteLine_versionId_position_idx" ON "QuoteLine"("versionId", "position");

-- CreateIndex
CREATE INDEX "QuoteLine_productId_idx" ON "QuoteLine"("productId");
