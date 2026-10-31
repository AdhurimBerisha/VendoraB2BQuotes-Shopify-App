import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { unauthenticated } from "../shopify.server";
import { runValidation } from "../models/import.server";
import { isInstalled } from "../models/shop.server";

type ImportCsvJob = { shop: string; importId: string; text: string };
type Deps = { getAdmin: (shop: string) => Promise<AdminApiContext> };

const defaultDeps: Deps = {
  getAdmin: async (shop) => (await unauthenticated.admin(shop)).admin,
};

// Files over INLINE_ROWS rows. A failure marks the import FAILED (shown on the page) and pg-boss retries.
const runImportCsv = async ({ shop, importId, text }: ImportCsvJob, deps: Deps = defaultDeps) => {
  if (!(await isInstalled(shop))) {
    console.log("import-csv skipped: shop not installed", { shop, importId });
    return;
  }
  await runValidation(await deps.getAdmin(shop), importId, text);
};

export { runImportCsv };
export type { ImportCsvJob };
