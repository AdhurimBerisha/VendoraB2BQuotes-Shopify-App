-- CreateTable
CREATE TABLE "Approval" (
    "id" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "reasons" JSONB NOT NULL,
    "requestedBy" BIGINT,
    "decidedBy" BIGINT,
    "decision" TEXT,
    "comment" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),

    CONSTRAINT "Approval_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Approval_versionId_idx" ON "Approval"("versionId");

-- AddForeignKey
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "QuoteVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

