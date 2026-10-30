-- CreateTable
CREATE TABLE "StaffMember" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "shopifyUserId" BIGINT NOT NULL,
    "displayName" TEXT NOT NULL,
    "email" TEXT,
    "role" TEXT NOT NULL DEFAULT 'REP',
    "locale" TEXT NOT NULL DEFAULT 'en',
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StaffMember_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "StaffMember_shop_shopifyUserId_key" ON "StaffMember"("shop", "shopifyUserId");

