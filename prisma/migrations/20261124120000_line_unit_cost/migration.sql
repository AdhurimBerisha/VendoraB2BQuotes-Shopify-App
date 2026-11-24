-- M10.2: cost per unit at save time (quote currency), for margin. NULL = unknown.
ALTER TABLE "QuoteLine" ADD COLUMN "unitCost" DECIMAL(14,4);
