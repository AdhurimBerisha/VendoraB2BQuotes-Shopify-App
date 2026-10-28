-- AlterTable
ALTER TABLE "Quote" ADD COLUMN     "contactCustomerId" TEXT;

-- CreateTable
CREATE TABLE "Shop" (
    "id" TEXT NOT NULL,
    "shopGid" TEXT,
    "installedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uninstalledAt" TIMESTAMP(3),
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "currencyCode" TEXT NOT NULL DEFAULT 'USD',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Shop_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookEvent" (
    "id" TEXT NOT NULL,
    "eventId" TEXT,
    "shop" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "error" TEXT,

    CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PrivacyRequest" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "customerGid" TEXT,
    "status" TEXT NOT NULL DEFAULT 'READY',
    "result" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PrivacyRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WebhookEvent_shop_receivedAt_idx" ON "WebhookEvent"("shop", "receivedAt");

-- CreateIndex
CREATE INDEX "PrivacyRequest_shop_idx" ON "PrivacyRequest"("shop");
