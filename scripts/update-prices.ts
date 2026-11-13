/**
 * Regenerates src/pricing-data.ts from models.dev and cross-checks it against LiteLLM (see scripts/prices.ts).
 * Needs network access (or saved copies), nothing else: no pi or Claude Code install.
 *
 *   npm run update:prices                       fetch models.dev and LiteLLM, rewrite the table
 *   npm run update:prices -- --check            exit 1 if the committed table differs from the source (writes nothing)
 *   npm run update:prices -- --json <file|->    also write a machine-readable summary (for the update bot)
 *   npm run update:prices -- --from <api.json>  read a saved models.dev catalog instead of fetching it
 *   npm run update:prices -- --litellm <file>   read a saved LiteLLM price file instead of fetching it
 *   npm run update:prices -- --no-cross-check   skip LiteLLM
 *   npm run update:prices -- --table <file>     read and write this table instead of src/pricing-data.ts (tests)
 *
 * Exit codes: 0 done (with --check: up to date); 1 --check found a difference; 2 the generator failed (fetch error,
 * schema change, unknown tier type, a price that would shadow a hand-kept one). LiteLLM disagreements, and a failed
 * LiteLLM fetch, are reported but never fatal. The report goes to stderr; `--json -` puts the summary on stdout.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { SUPPLEMENTAL_PRICES } from "../src/pricing.ts";
import { LITELLM_URL, MODELS_DEV_URL, crossCheck, diffTables, fromModelsDev, parseTable, renderTable, shadowedSupplements, type CrossCheck, type TableDiff } from "./prices.ts";

export interface PriceSummary extends TableDiff {
  snapshot: string;
  source: string;
  /** The committed table is byte-identical to what the source generates. */
  upToDate: boolean;
  crossCheck: CrossCheck | null;
  crossCheckError?: string;
}

const { values: opts } = parseArgs({
  options: {
    check: { type: "boolean", default: false },
    json: { type: "string" },
    from: { type: "string" },
    litellm: { type: "string" },
    "no-cross-check": { type: "boolean", default: false },
    table: { type: "string" },
  },
});
const tablePath = opts.table ?? join(import.meta.dirname, "..", "src", "pricing-data.ts");

async function load(file: string | undefined, url: string): Promise<unknown> {
  if (file) return JSON.parse(readFileSync(file, "utf8"));
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

const fmt = (v: unknown) => (v === undefined ? "-" : typeof v === "number" ? `${v}` : JSON.stringify(v));
const log = (s: string) => console.error(s);

async function main(): Promise<number> {
  const source = opts.from ?? MODELS_DEV_URL;
  const table = fromModelsDev(await load(opts.from, MODELS_DEV_URL));
  const shadowing = shadowedSupplements(table.prices, SUPPLEMENTAL_PRICES);
  if (shadowing.length) throw new Error(`models.dev lists ${shadowing.join(", ")} with prices that differ from SUPPLEMENTAL_PRICES in src/pricing.ts; reconcile them by hand`);

  const committedText = readFileSync(tablePath, "utf8");
  const text = renderTable(table);
  const upToDate = text === committedText;
  const diff = diffTables(parseTable(committedText), table.prices);

  let cross: CrossCheck | null = null;
  let crossError: string | undefined;
  if (!opts["no-cross-check"]) {
    try {
      cross = crossCheck(table.prices, await load(opts.litellm, LITELLM_URL));
    } catch (e) {
      crossError = e instanceof Error ? e.message : String(e);
    }
  }

  log(`models.dev snapshot ${table.snapshot}: ${Object.keys(table.prices).length} models`);
  if (upToDate) log("src/pricing-data.ts is up to date.");
  else {
    for (const id of diff.added) log(`  added   ${id}`);
    for (const id of diff.removed) log(`  removed ${id}`);
    for (const c of diff.changed) log(`  changed ${c.id}: ${Object.entries(c.fields).map(([k, [a, b]]) => `${k} ${fmt(a)} -> ${fmt(b)}`).join(", ")}`);
    if (!diff.added.length && !diff.removed.length && !diff.changed.length) log("  (no price changes: header or format only)");
  }
  if (crossError) log(`LiteLLM cross-check skipped: ${crossError}`);
  else if (cross) {
    log(`LiteLLM cross-check: ${cross.disagreements.length ? `${cross.disagreements.length} disagreement(s)` : "no disagreements"}`);
    for (const d of cross.disagreements) log(`  ${d.id} ${d.field}: models.dev ${fmt(d.ours)}, LiteLLM ${fmt(d.litellm)}`);
    if (cross.onlyOurs.length) log(`  only in models.dev: ${cross.onlyOurs.join(", ")}`);
    if (cross.onlyLitellm.length) log(`  only in LiteLLM: ${cross.onlyLitellm.join(", ")}`);
  }

  if (opts.json) {
    const summary: PriceSummary = { snapshot: table.snapshot, source, upToDate, ...diff, crossCheck: cross, ...(crossError ? { crossCheckError: crossError } : {}) };
    const out = `${JSON.stringify(summary, null, 2)}\n`;
    if (opts.json === "-") process.stdout.write(out);
    else writeFileSync(opts.json, out);
  }

  if (opts.check) {
    if (!upToDate) log("The price table differs from models.dev: run `npm run update:prices`.");
    return upToDate ? 0 : 1;
  }
  if (!upToDate) {
    writeFileSync(tablePath, text);
    log(`Wrote ${tablePath}`);
  }
  return 0;
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    console.error(`update-prices failed: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  },
);
