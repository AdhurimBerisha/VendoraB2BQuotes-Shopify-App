// Translation checks (CI): every locale has the keys en.json has, and every key the code uses
// literally (t("…"), new UserError("…") and friends) exists in en.json.
// Run: npm run check:locales
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const PLURAL = /_(zero|one|two|few|many|other)$/;

// { a: { b: "x" } } → ["a.b"]; plural keys also count as their base key ("rows_one" → "rows").
const flattenKeys = (object, prefix = "") =>
  Object.entries(object).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === "object") return flattenKeys(value, path);
    return PLURAL.test(path) ? [path, path.replace(PLURAL, "")] : [path];
  });

const KEY_PATTERNS = [
  /\bt\(\s*"([a-z][\w.]*)"/g,
  /new (?:UserError|ConflictError|NotFoundError|ForbiddenError)\(\s*"([a-z][\w.]*)"/g,
];

const usedKeys = (source) => KEY_PATTERNS.flatMap((pattern) => [...source.matchAll(pattern)].map((match) => match[1]));

// Problems as text lines; empty = all good.
const checkLocales = (locales, sources) => {
  const problems = [];
  const en = new Set(flattenKeys(locales.en ?? {}));
  for (const [name, messages] of Object.entries(locales)) {
    if (name === "en") continue;
    const keys = new Set(flattenKeys(messages));
    for (const key of en) if (!keys.has(key) && !PLURAL.test(key)) problems.push(`${name}.json is missing "${key}"`);
  }
  for (const [file, source] of Object.entries(sources)) {
    for (const key of usedKeys(source)) if (!en.has(key)) problems.push(`${file} uses "${key}", missing from en.json`);
  }
  return problems;
};

const sourceFiles = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "types" || entry.name === "test" ? [] : sourceFiles(path);
    return /\.(ts|tsx)$/.test(entry.name) && !/\.test\./.test(entry.name) ? [path] : [];
  });

const main = () => {
  const localeDir = "app/locales";
  const locales = Object.fromEntries(
    readdirSync(localeDir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => [name.replace(/\.json$/, ""), JSON.parse(readFileSync(join(localeDir, name), "utf8"))]),
  );
  const sources = Object.fromEntries(sourceFiles("app").map((file) => [file, readFileSync(file, "utf8")]));
  const problems = checkLocales(locales, sources);
  for (const problem of problems) console.error(problem);
  console.log(problems.length ? `✗ ${problems.length} translation problems` : "✓ translations complete");
  process.exitCode = problems.length ? 1 : 0;
};

if (process.argv[1] === fileURLToPath(import.meta.url)) main();

export { checkLocales, flattenKeys };
