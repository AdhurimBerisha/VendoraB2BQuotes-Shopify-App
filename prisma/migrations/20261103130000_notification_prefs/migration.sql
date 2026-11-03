-- AlterTable
ALTER TABLE "Shop" ADD COLUMN     "name" TEXT;

-- AlterTable
ALTER TABLE "StaffMember" ADD COLUMN     "notificationPrefs" JSONB NOT NULL DEFAULT '{}';
