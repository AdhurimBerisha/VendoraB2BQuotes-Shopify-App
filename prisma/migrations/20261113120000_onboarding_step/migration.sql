-- M5.2: where the shop is in the setup wizard.
ALTER TABLE "Shop" ADD COLUMN "onboardingStep" TEXT NOT NULL DEFAULT 'WELCOME';

-- Shops that already have quotes don't need the wizard.
UPDATE "Shop" SET "onboardingStep" = 'DONE' WHERE "id" IN (SELECT "shop" FROM "Quote");
