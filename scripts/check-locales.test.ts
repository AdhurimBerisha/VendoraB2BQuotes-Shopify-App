import { expect, test } from "vitest";
import { checkLocales, flattenKeys } from "./check-locales.mjs";

test("flattenKeys: nested paths; plural keys also count as their base key", () => {
  expect(flattenKeys({ a: { b: "x", rows_one: "1", rows_other: "n" } })).toEqual([
    "a.b",
    "a.rows_one",
    "a.rows",
    "a.rows_other",
    "a.rows",
  ]);
});

test("a key missing from another locale fails", () => {
  const problems = checkLocales({ en: { nav: { quotes: "Quotes", settings: "Settings" } }, de: { nav: { quotes: "Angebote" } } }, {});
  expect(problems).toEqual(['de.json is missing "nav.settings"']);
});

test("a key used in code but missing from en.json fails; plurals and present keys pass", () => {
  const locales = { en: { quote: { errors: { noLines: "Add a product." } }, rows_one: "1 row", rows_other: "{{count}} rows" } };
  const sources = {
    "a.ts": 'throw new UserError("quote.errors.noLines"); t("rows", { count: 2 });',
    "b.tsx": 'throw new ConflictError("quote.errors.gone");',
  };
  expect(checkLocales(locales, sources)).toEqual(['b.tsx uses "quote.errors.gone", missing from en.json']);
});
