-- M10.4: payment terms (Shopify template id + its name for buyer pages) and deposit % sent to the draft order.
ALTER TABLE "Quote" ADD COLUMN "paymentTermsTemplateId" TEXT,
ADD COLUMN "paymentTermsName" TEXT,
ADD COLUMN "depositPct" INTEGER;
