import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import db from "../db.server";
import { UserError } from "../lib/errors";
import { logger } from "../lib/logger.server";
import { ShopifyDenied, ShopifyUserErrors } from "../shopify/client.server";
import { searchCompanies } from "../shopify/companies.server";
import { createDraftOrder, deleteDraftOrder, getDraftOrder, quoteTag } from "../shopify/draft-orders.server";
import type { StaffActor } from "./actor";
import { requirePermission } from "./permissions";
import { missingScopes } from "./shop.server";

// M5.2 setup wizard. Shop.onboardingStep holds the step the shop is on.
const STEPS = ["WELCOME", "ELIGIBILITY", "SETTINGS", "TEAM", "CONNECTION", "SAMPLE", "DONE"] as const;
type Step = (typeof STEPS)[number];

type Check = { key: "b2b" | "company" | "mainContact" | "scopes"; ok: boolean };

// What the store needs before a first quote can work. Every failing check blocks the wizard.
// ponytail: looks at the first 20 companies only (searchCompanies' page); a store whose first 20
// all lack a main contact fails the check even if a later one has it.
const runEligibility = async (admin: AdminApiContext, grantedScopes: string | undefined): Promise<Check[]> => {
  const scopes: Check = { key: "scopes", ok: missingScopes(grantedScopes).length === 0 };

  let companies;
  try {
    companies = (await searchCompanies(admin)).nodes;
  } catch (error) {
    // Stores without B2B (not on Plus) may not read companies at all.
    if (!(error instanceof ShopifyDenied)) throw error;
    return [{ key: "b2b", ok: false }, scopes];
  }
  return [
    { key: "b2b", ok: true },
    { key: "company", ok: companies.length > 0 },
    { key: "mainContact", ok: companies.some((company) => company.mainContact && company.locations.nodes.length > 0) },
    scopes,
  ];
};

// Moves the shop from `from` to the step after it. The where clause makes a double click harmless.
const advance = async (actor: StaffActor, from: string, grantedScopes: string | undefined) => {
  requirePermission(actor, "settings.manage");
  const index = STEPS.findIndex((step) => step === from);
  const next = index < 0 ? undefined : STEPS[index + 1];
  if (!next) throw new UserError("errors.invalidInput", { fields: "from" });
  if (from === "ELIGIBILITY") {
    const checks = await runEligibility(actor.admin, grantedScopes);
    if (checks.some((check) => !check.ok)) throw new UserError("onboarding.errors.blocked");
  }
  await db.shop.updateMany({ where: { id: actor.shop, onboardingStep: from }, data: { onboardingStep: next } });
  logger.info({ shop: actor.shop, from, next }, "onboarding step done");
};

// "Skip setup" and the last step.
const finishOnboarding = async (actor: StaffActor) => {
  requirePermission(actor, "settings.manage");
  await db.shop.update({ where: { id: actor.shop }, data: { onboardingStep: "DONE" } });
  logger.info({ shop: actor.shop }, "onboarding finished");
};

type ConnectionResult = { passed: true } | { passed: false; message: string };

// Proves the whole path a quote takes: creates a draft order for the first company that can buy,
// reads it back and deletes it. Shopify's own words come back when it says no.
const connectionTest = async (actor: StaffActor): Promise<ConnectionResult> => {
  requirePermission(actor, "settings.manage");
  const companies = await searchCompanies(actor.admin);
  const company = companies.nodes.find((candidate) => candidate.mainContact && candidate.locations.nodes.length > 0);
  const location = company?.locations.nodes[0];
  if (!company?.mainContact || !location) throw new UserError("onboarding.errors.noCompany");

  try {
    const draft = await createDraftOrder(actor.admin, {
      purchasingEntity: {
        purchasingCompany: {
          companyId: company.id,
          companyLocationId: location.id,
          companyContactId: company.mainContact.id,
        },
      },
      lineItems: [
        {
          title: "Vendora connection test",
          quantity: 1,
          originalUnitPriceWithCurrency: { amount: "1.00", currencyCode: location.currency },
        },
      ],
      // A quote tag, so the draft_orders/create webhook treats it as ours and never imports it (M3.5).
      tags: [quoteTag("connection-test")],
    });
    try {
      if (!(await getDraftOrder(actor.admin, draft.id))) throw new Error("the new draft order can't be read back");
    } finally {
      await deleteDraftOrder(actor.admin, draft.id);
    }
  } catch (error) {
    if (!(error instanceof ShopifyUserErrors) && !(error instanceof ShopifyDenied)) throw error;
    logger.warn({ shop: actor.shop, message: error.message }, "onboarding connection test failed");
    return { passed: false, message: error.message };
  }
  logger.info({ shop: actor.shop }, "onboarding connection test passed");
  return { passed: true };
};

export { STEPS, advance, connectionTest, finishOnboarding, runEligibility };
export type { Check, ConnectionResult, Step };
