-- M10.3: follow-up emails to the rep, in shop-local days. NULL = off.
ALTER TABLE "Shop" ADD COLUMN "followUpNotViewedDays" INTEGER,
ADD COLUMN "followUpNotOrderedDays" INTEGER;
