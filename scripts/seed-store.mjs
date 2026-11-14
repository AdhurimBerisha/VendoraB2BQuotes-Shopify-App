// Fills a fresh dev or review store with what Vendora needs to be tried out (G-12):
// 6 products, 2 companies that can buy (one with a 10 % off catalog) and 1 company without a
// main contact (to see the setup wizard's check fail).
//
// Vendora's own token is read-only for products and companies, so this goes through the Shopify CLI:
//   1. npx shopify store auth --store <shop>.myshopify.com --scopes write_products,write_customers
//   2. node scripts/seed-store.mjs <shop>.myshopify.com
// The store needs B2B (Plus or a Plus dev store). Running it twice does nothing the second time.
// ponytail: all or nothing. If it stops halfway, delete the "Seed …" items in the admin and run it again.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const shop = process.argv[2] ?? "";
// Also keeps the shell command below safe: nothing but a plain shop domain gets in.
if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop)) {
  console.error("Usage: node scripts/seed-store.mjs <shop>.myshopify.com");
  process.exit(1);
}

const PRODUCTS = [
  { title: "Seed Widget Small", sku: "VSEED-1", price: "12.50" },
  { title: "Seed Widget Medium", sku: "VSEED-2", price: "24.00" },
  { title: "Seed Widget Large", sku: "VSEED-3", price: "49.95" },
  { title: "Seed Gadget Basic", sku: "VSEED-4", price: "120.00" },
  { title: "Seed Gadget Pro", sku: "VSEED-5", price: "480.00" },
  { title: "Seed Machine", sku: "VSEED-6", price: "2500.00" },
];

const address = (recipient, address1, city, zoneCode, zip) => ({ recipient, address1, city, zoneCode, zip, countryCode: "US" });
const COMPANIES = [
  {
    name: "Seed Wholesale One",
    contact: { firstName: "Olivia", lastName: "One", email: "seed-buyer-1@example.com" },
    address: address("Olivia One", "100 Main St", "New York", "NY", "10001"),
    catalog: false,
  },
  {
    name: "Seed Wholesale Two",
    contact: { firstName: "Noah", lastName: "Two", email: "seed-buyer-2@example.com" },
    address: address("Noah Two", "200 Market St", "San Francisco", "CA", "94105"),
    catalog: true,
  },
  { name: "Seed No Contact", contact: null, address: null, catalog: false },
];

const workDir = mkdtempSync(join(tmpdir(), "vendora-seed-"));

// One Admin API call through `shopify store execute`. The CLI prints one JSON object per line
// (progress, then the result or an error).
const execute = (query, variables = {}) => {
  const queryFile = join(workDir, "query.graphql");
  const variableFile = join(workDir, "variables.json");
  writeFileSync(queryFile, query);
  writeFileSync(variableFile, JSON.stringify(variables));
  const run = spawnSync(
    `npx shopify store execute --store ${shop} --query-file "${queryFile}" --variable-file "${variableFile}" --allow-mutations --json --no-input`,
    { shell: true, encoding: "utf8" },
  );
  const lines = run.stdout
    .split("\n")
    .filter((line) => line.trim().startsWith("{"))
    .map((line) => JSON.parse(line));
  const failure = lines.find((line) => line.error);
  if (failure) throw new Error([failure.error.message, ...(failure.error.nextSteps ?? [])].join("\n"));
  const result = lines.find((line) => "data" in line);
  if (!result?.data) throw new Error(`No result from the Shopify CLI.\n${run.stdout}\n${run.stderr}`);
  return result.data;
};

// The payload of a mutation, or an error with Shopify's messages.
const mutate = (query, variables, field) => {
  const payload = execute(query, variables)[field];
  if (payload.userErrors.length) {
    throw new Error(`${field}: ${payload.userErrors.map((error) => error.message).join("; ")}`);
  }
  return payload;
};

const seedProduct = ({ title, sku, price }) =>
  mutate(
    `mutation SeedProduct($input: ProductSetInput!) {
      productSet(synchronous: true, input: $input) { product { id } userErrors { field message } }
    }`,
    {
      input: {
        title,
        status: "ACTIVE",
        productOptions: [{ name: "Title", values: [{ name: "Default Title" }] }],
        variants: [{ optionValues: [{ optionName: "Title", name: "Default Title" }], price, sku }],
      },
    },
    "productSet",
  );

const seedCompany = ({ name, contact, address: shippingAddress, catalog }, currency) => {
  const { company } = mutate(
    `mutation SeedCompany($input: CompanyCreateInput!) {
      companyCreate(input: $input) {
        company {
          id
          mainContact { id }
          contactRoles(first: 5) { nodes { id name } }
          locations(first: 1) { nodes { id } }
          contacts(first: 1) { nodes { id roleAssignments(first: 1) { nodes { id } } } }
        }
        userErrors { field message }
      }
    }`,
    {
      input: {
        company: { name },
        ...(contact && { companyContact: contact }),
        ...(shippingAddress && { companyLocation: { name: `${name} HQ`, shippingAddress, billingSameAsShipping: true } }),
      },
    },
    "companyCreate",
  );
  const locationId = company.locations.nodes[0]?.id;
  const createdContact = company.contacts.nodes[0];

  // A quote needs a main contact who may order for the location. Shopify usually sets both up when
  // the company is created with a contact; fill in whatever it left out.
  if (createdContact && !company.mainContact) {
    mutate(
      `mutation SeedMainContact($companyId: ID!, $companyContactId: ID!) {
        companyAssignMainContact(companyId: $companyId, companyContactId: $companyContactId) {
          company { id } userErrors { field message }
        }
      }`,
      { companyId: company.id, companyContactId: createdContact.id },
      "companyAssignMainContact",
    );
  }
  if (createdContact && locationId && createdContact.roleAssignments.nodes.length === 0) {
    const role = company.contactRoles.nodes.find((candidate) => candidate.name === "Location admin") ?? company.contactRoles.nodes[0];
    mutate(
      `mutation SeedRole($companyContactId: ID!, $companyContactRoleId: ID!, $companyLocationId: ID!) {
        companyContactAssignRole(
          companyContactId: $companyContactId, companyContactRoleId: $companyContactRoleId, companyLocationId: $companyLocationId
        ) { companyContactRoleAssignment { id } userErrors { field message } }
      }`,
      { companyContactId: createdContact.id, companyContactRoleId: role.id, companyLocationId: locationId },
      "companyContactAssignRole",
    );
  }

  if (catalog && locationId) {
    // Price list only, no publication: every product stays available, 10 % cheaper.
    const { priceList } = mutate(
      `mutation SeedPriceList($input: PriceListCreateInput!) {
        priceListCreate(input: $input) { priceList { id } userErrors { field message } }
      }`,
      { input: { name: `${name} prices`, currency, parent: { adjustment: { type: "PERCENTAGE_DECREASE", value: 10 } } } },
      "priceListCreate",
    );
    mutate(
      `mutation SeedCatalog($input: CatalogCreateInput!) {
        catalogCreate(input: $input) { catalog { id } userErrors { field message } }
      }`,
      {
        input: {
          title: `${name} catalog`,
          status: "ACTIVE",
          context: { companyLocationIds: [locationId] },
          priceListId: priceList.id,
        },
      },
      "catalogCreate",
    );
  }
};

try {
  const check = execute(`query SeedCheck {
    shop { currencyCode }
    products(first: 1, query: "sku:${PRODUCTS[0].sku}") { nodes { id } }
  }`);
  if (check.products.nodes.length) {
    console.log(`${shop} is already seeded (found ${PRODUCTS[0].sku}); nothing to do.`);
  } else {
    for (const product of PRODUCTS) {
      seedProduct(product);
      console.log("product", product.sku, product.title);
    }
    for (const company of COMPANIES) {
      seedCompany(company, check.shop.currencyCode);
      console.log("company", company.name, company.catalog ? "(10 % off catalog)" : "");
    }
    console.log("Done.");
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
