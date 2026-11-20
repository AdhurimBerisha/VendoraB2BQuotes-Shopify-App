-- M9.2: custom lines (freight, fees, services) have no product variant.
ALTER TABLE "QuoteLine" ALTER COLUMN "variantId" DROP NOT NULL,
ALTER COLUMN "productId" DROP NOT NULL;
