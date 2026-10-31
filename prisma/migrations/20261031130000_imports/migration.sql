-- CreateTable
CREATE TABLE "Import" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "quoteId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "rowCount" INTEGER NOT NULL DEFAULT 0,
    "lines" JSONB,
    "report" JSONB,
    "error" TEXT,
    "createdBy" BIGINT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Import_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Import_shop_quoteId_createdAt_idx" ON "Import"("shop", "quoteId", "createdAt");

