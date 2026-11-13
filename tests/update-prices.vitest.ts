import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { crossCheck, diffTables, fromModelsDev, parseTable, renderTable, shadowedSupplements } from "../scripts/prices.ts";
import { ANTHROPIC_PRICES } from "../src/pricing-data.js";
import { SUPPLEMENTAL_PRICES } from "../src/pricing.js";

// Trimmed copies of the real sources (2026-11-13): models.dev's catalog and LiteLLM's price file.
const FIXTURES = join(import.meta.dirname, "fixtures", "prices");
const MODELS_DEV = join(FIXTURES, "models-dev.json");
const LITELLM = join(FIXTURES, "litellm.json");
const modelsDev = () => JSON.parse(readFileSync(MODELS_DEV, "utf8"));
const litellm = () => JSON.parse(readFileSync(LITELLM, "utf8"));

describe("models.dev converter", () => {
  it("converts a plain model and a tiered one, keeping only priced claude-* ids", () => {
    const { prices, snapshot } = fromModelsDev(modelsDev());
    expect(Object.keys(prices)).toEqual(["claude-haiku-5-5", "claude-opus-5-5", "claude-sonnet-5-5"]);
    expect(prices["claude-opus-5-5"]).toEqual({ input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 });
    expect(prices["claude-haiku-5-5"]).toEqual({
      input: 0.1,
      output: 0.5,
      cacheRead: 0.01,
      cacheWrite: 0.125,
      tiers: [{ above: 100_000, input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 }],
    });
    // The newest last_updated of the models kept (the unpriced entry and other providers do not count).
    expect(snapshot).toBe("2026-10-07");
  });

  it("fails loudly on a tier type it does not know, or a missing price", () => {
    const api = modelsDev();
    api.anthropic.models["claude-haiku-5-5"].cost.tiers[0].tier.type = "time_of_day";
    expect(() => fromModelsDev(api)).toThrow(/claude-haiku-5-5 tier 0: unknown tier type "time_of_day"/);
    const noSize = modelsDev();
    delete noSize.anthropic.models["claude-haiku-5-5"].cost.tiers[0].tier.size;
    expect(() => fromModelsDev(noSize)).toThrow(/tier size undefined/);
    const noRead = modelsDev();
    delete noRead.anthropic.models["claude-opus-5-5"].cost.cache_read;
    expect(() => fromModelsDev(noRead)).toThrow(/claude-opus-5-5 cache_read: expected a non-negative price/);
    expect(() => fromModelsDev({ openai: {} })).toThrow(/no anthropic.models/);
  });

  it("sorts tiers by size", () => {
    const api = modelsDev();
    const tiers = api.anthropic.models["claude-haiku-5-5"].cost.tiers;
    tiers.unshift({ ...tiers[0], input: 1, tier: { type: "context", size: 500_000 } });
    expect(fromModelsDev(api).prices["claude-haiku-5-5"]!.tiers!.map((t) => t.above)).toEqual([100_000, 500_000]);
  });
});

describe("generated table", () => {
  it("renders deterministically and reads back to the same prices", () => {
    const snap = fromModelsDev(modelsDev());
    const text = renderTable(snap);
    expect(renderTable(fromModelsDev(modelsDev()))).toBe(text);
    expect(parseTable(text)).toEqual(snap.prices);
    expect(text).toContain("from models.dev (snapshot 2026-10-07)");
    expect(text).toContain(`"claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125, tiers: [{ above: 100000, input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 }] },`);
  });

  it("reads the committed table, and one in the old pre-tier format", () => {
    expect(parseTable(readFileSync(join(import.meta.dirname, "..", "src", "pricing-data.ts"), "utf8"))).toEqual(ANTHROPIC_PRICES);
    const old = `export interface ModelPrice {\n  input: number;\n}\n\nexport const ANTHROPIC_PRICES: Record<string, ModelPrice> = {\n  "claude-x": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },\n};\n`;
    expect(parseTable(old)).toEqual({ "claude-x": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 } });
    expect(() => parseTable("export const X = {};")).toThrow(/no ANTHROPIC_PRICES table/);
    expect(() => parseTable(old.replace('"claude-x": {', '"claude-x":\n {'))).toThrow(/cannot read line/);
  });

  it("diffs two tables: added, removed and each changed field", () => {
    const before = { a: { input: 1, output: 5, cacheRead: 0.2, cacheWrite: 1.25 }, gone: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 } };
    const after = {
      a: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25, tiers: [{ above: 100_000, input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 }] },
      new: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
    };
    expect(diffTables(before, after)).toEqual({
      added: ["new"],
      removed: ["gone"],
      changed: [{ id: "a", fields: { cacheRead: [0.2, 0.1], tiers: [[], after.a.tiers] } }],
    });
    expect(diffTables(after, after)).toEqual({ added: [], removed: [], changed: [] });
  });

  it("refuses ids that would shadow a hand-kept price with different numbers", () => {
    const sup = { "claude-sonnet-4": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } };
    expect(shadowedSupplements({ "claude-sonnet-4-20250514": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } }, sup)).toEqual([]);
    expect(shadowedSupplements({ "claude-sonnet-4-20250514": { input: 3, output: 15, cacheRead: 0.25, cacheWrite: 3.75 } }, sup)).toEqual(["claude-sonnet-4-20250514"]);
    expect(shadowedSupplements({ "claude-sonnet-4-5": { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 } }, sup)).toEqual([]);
    // The committed table shadows nothing.
    expect(shadowedSupplements(ANTHROPIC_PRICES, SUPPLEMENTAL_PRICES)).toEqual([]);
  });
});

describe("LiteLLM cross-check", () => {
  it("agrees with the saved sources on base rates, the Haiku 5.5 tier and the 1-hour writes", () => {
    const r = crossCheck(fromModelsDev(modelsDev()).prices, litellm());
    expect(r.disagreements).toEqual([]);
    expect(r.onlyOurs).toEqual([]);
    expect(r.onlyLitellm).toEqual([]); // gpt-4o is another provider, not listed
  });

  it("reports every kind of disagreement, and models only one source lists", () => {
    const ll = litellm();
    ll["claude-opus-5-5"].cache_read_input_token_cost = 3e-7; // $0.30 vs $0.20
    ll["claude-opus-5-5"].cache_creation_input_token_cost_above_1hr = 1e-5; // $10, not 2 x $4
    ll["claude-haiku-5-5"].output_cost_per_token_above_100k_tokens = 3e-6;
    ll["claude-sonnet-5-5"].input_cost_per_token_above_200k_tokens = 4e-6; // a tier models.dev lacks
    ll["claude-legacy-1"] = { litellm_provider: "anthropic", input_cost_per_token: 1e-6 };
    const prices = fromModelsDev(modelsDev()).prices;
    prices["claude-new-1"] = { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 };
    const r = crossCheck(prices, ll);
    expect(r.disagreements).toEqual([
      { id: "claude-haiku-5-5", field: "output above 100k", ours: 2.5, litellm: 3 },
      { id: "claude-opus-5-5", field: "cacheRead", ours: 0.2, litellm: 0.3 },
      { id: "claude-opus-5-5", field: "1h cacheWrite", ours: 8, litellm: 10 },
      { id: "claude-sonnet-5-5", field: "tier above 200k", litellm: 4 },
    ]);
    expect(r.onlyOurs).toEqual(["claude-new-1"]);
    expect(r.onlyLitellm).toEqual(["claude-legacy-1"]);
  });

  it("reports a rate LiteLLM leaves out or lists as something other than a number", () => {
    const ll = litellm();
    delete ll["claude-opus-5-5"].cache_read_input_token_cost;
    ll["claude-opus-5-5"].output_cost_per_token = "2e-5";
    delete ll["claude-haiku-5-5"].cache_creation_input_token_cost_above_1hr_above_100k_tokens;
    expect(crossCheck(fromModelsDev(modelsDev()).prices, ll).disagreements).toEqual([
      { id: "claude-haiku-5-5", field: "1h cacheWrite above 100k", ours: 1 },
      { id: "claude-opus-5-5", field: "output", ours: 20 },
      { id: "claude-opus-5-5", field: "cacheRead", ours: 0.2 },
    ]);
  });

  it("reports a tier LiteLLM does not list", () => {
    const ll = litellm();
    for (const k of Object.keys(ll["claude-haiku-5-5"])) if (k.includes("above_100k")) delete ll["claude-haiku-5-5"][k];
    expect(crossCheck(fromModelsDev(modelsDev()).prices, ll).disagreements).toEqual([{ id: "claude-haiku-5-5", field: "tier above 100k", ours: 0.5 }]);
  });
});

describe("update-prices CLI (saved sources, no network)", () => {
  const run = (table: string, ...args: string[]) =>
    spawnSync(process.execPath, ["--import", "tsx", join(import.meta.dirname, "..", "scripts", "update-prices.ts"), "--from", MODELS_DEV, "--litellm", LITELLM, "--table", table, ...args], { encoding: "utf8" });

  it("writes the table, then --check passes and a rerun changes nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), "prices-"));
    const table = join(dir, "pricing-data.ts");
    copyFileSync(join(import.meta.dirname, "..", "src", "pricing-data.ts"), table);
    const stale = run(table, "--check", "--json", join(dir, "summary.json"));
    expect(stale.status, stale.stderr).toBe(1);
    expect(stale.stderr).toContain("run `npm run update:prices`");
    const summary = JSON.parse(readFileSync(join(dir, "summary.json"), "utf8"));
    // The fixture lists 3 of the committed table's models, so the rest read as removed.
    expect(summary).toMatchObject({ snapshot: "2026-10-07", upToDate: false, added: [], crossCheck: { disagreements: [] } });
    expect(summary.removed).toContain("claude-fable-5");

    expect(run(table).status).toBe(0);
    const written = readFileSync(table, "utf8");
    const check = run(table, "--check", "--json", "-");
    expect(check.status, check.stderr).toBe(0);
    expect(JSON.parse(check.stdout)).toMatchObject({ upToDate: true, added: [], removed: [], changed: [] });
    expect(run(table).status).toBe(0);
    expect(readFileSync(table, "utf8")).toBe(written);
  });

  it("exits 2 on a generator failure and leaves the table alone", () => {
    const dir = mkdtempSync(join(tmpdir(), "prices-"));
    const table = join(dir, "pricing-data.ts");
    writeFileSync(table, "unchanged");
    const api = modelsDev();
    api.anthropic.models["claude-haiku-5-5"].cost.tiers[0].tier.type = "batch";
    writeFileSync(join(dir, "api.json"), JSON.stringify(api));
    const r = spawnSync(process.execPath, ["--import", "tsx", join(import.meta.dirname, "..", "scripts", "update-prices.ts"), "--from", join(dir, "api.json"), "--no-cross-check", "--table", table], { encoding: "utf8" });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('update-prices failed: claude-haiku-5-5 tier 0: unknown tier type "batch"');
    expect(readFileSync(table, "utf8")).toBe("unchanged");
  });

  it("reports a failed LiteLLM read without failing", () => {
    const dir = mkdtempSync(join(tmpdir(), "prices-"));
    const table = join(dir, "pricing-data.ts");
    writeFileSync(table, renderTable(fromModelsDev(modelsDev())));
    const r = spawnSync(process.execPath, ["--import", "tsx", join(import.meta.dirname, "..", "scripts", "update-prices.ts"), "--from", MODELS_DEV, "--litellm", join(dir, "missing.json"), "--table", table, "--check", "--json", "-"], { encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toContain("LiteLLM cross-check skipped");
    expect(JSON.parse(r.stdout)).toMatchObject({ upToDate: true, crossCheck: null, crossCheckError: expect.stringContaining("missing.json") });
  });
});
