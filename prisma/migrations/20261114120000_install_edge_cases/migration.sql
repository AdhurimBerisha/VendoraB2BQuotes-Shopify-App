-- M5.3: the store lost B2B (banner, sending blocked); show "welcome back" once after a reinstall.
ALTER TABLE "Shop" ADD COLUMN "b2bUnavailable" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Shop" ADD COLUMN "welcomeBack" BOOLEAN NOT NULL DEFAULT false;
