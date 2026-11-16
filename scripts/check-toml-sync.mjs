// Fails if shopify.app.toml and the staging/dev configs disagree on scopes, webhooks or the app proxy.
// Only client_id, name and URLs may differ between the two apps. Run: node scripts/check-toml-sync.mjs
import { existsSync, readFileSync } from "node:fs";

const SECTIONS = ["access_scopes", "webhooks", "app_proxy"];

// The lines of the compared sections (and their sub-tables), without comments, blank lines or URLs.
const pick = (file) => {
  let keep = false;
  const lines = [];
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const header = /^\[+([^\]]+)\]+$/.exec(line);
    if (header) keep = SECTIONS.some((s) => header[1] === s || header[1].startsWith(`${s}.`));
    if (keep && !/^url\s*=/.test(line)) lines.push(line);
  }
  return lines.join("\n");
};

const main = pick("shopify.app.toml");
for (const other of ["shopify.app.staging.toml", "shopify.app.dev.toml"].filter((f) => existsSync(f))) {
  if (!main || main !== pick(other)) {
    console.error(`shopify.app.toml and ${other} differ in scopes, webhooks or app proxy`);
    process.exit(1);
  }
}
console.log("app configs in sync");
