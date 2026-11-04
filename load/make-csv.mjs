// Writes a CSV for the import load test (M4.4): `node load/make-csv.mjs SKU-1,SKU-2 10000 > load/big.csv`
// Repeats the given real dev-store SKUs with random quantities; the import merges repeats per variant.
const [skuList, rowsArg = "10000"] = process.argv.slice(2);
if (!skuList) {
  console.error("usage: node load/make-csv.mjs <sku,sku,...> [rows]");
  process.exit(1);
}
const skus = skuList.split(",").map((sku) => sku.trim()).filter(Boolean);
const rows = Number(rowsArg);
const out = ["sku,quantity"];
for (let i = 0; i < rows; i++) out.push(`${skus[i % skus.length]},${1 + Math.floor(Math.random() * 5)}`);
process.stdout.write(`${out.join("\n")}\n`);
