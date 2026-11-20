/**
 * The price table's source and checks, as plain functions (no I/O): used by scripts/update-prices.ts and
 * tested on saved copies of both sources.
 *
 * - Source: models.dev (`https://models.dev/api.json`; `anthropic.models`, `openai.models`, `google.models`), USD per
 *   million tokens. Claude models for Claude Code (and Claude served elsewhere), OpenAI for Codex, Gemini for Antigravity.
 * - Cross-check: LiteLLM's `model_prices_and_context_window.json`, USD per token. Disagreements are reported,
 *   never fatal: both are community-kept, either can lag, and a human reviews the table either way.
 *
 * The table holds one flat id space: which provider an id belongs to follows from its family (`providerOfId`), which
 * is also how `src/pricing.ts` finds it.
 */
import { providerOfId, type ModelPrice, type PriceProvider, type PriceRates, type PriceTier } from "../src/pricing.ts";

export const MODELS_DEV_URL = "https://models.dev/api.json";
export const LITELLM_URL = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

export type PriceTable = Record<string, ModelPrice>;
export interface Snapshot {
  prices: PriceTable;
  /** The newest `last_updated` of the models kept: changes only when the data does, so it never causes a diff by itself. */
  snapshot: string;
}

const RATE_KEYS = ["input", "output", "cacheRead", "cacheWrite"] as const;
/** Anthropic bills 1-hour cache writes at twice the input rate (src/pricing.ts applies the same rule). */
const CACHE_WRITE_1H_INPUT_MULTIPLIER = 2;

type Json = Record<string, any>;

/** A non-negative, finite number, or a loud failure naming where it came from. */
function rate(v: unknown, where: string): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) throw new Error(`${where}: expected a non-negative price, got ${JSON.stringify(v)}`);
  return v;
}

/**
 * One call's rates. Anthropic lists all four for every model and a missing one is an error. OpenAI and Google bill no
 * cache-write premium and some of their models have no cache discount, so there a rate models.dev leaves out is the
 * input rate (never 0: that would price those tokens as free).
 */
function ratesOf(c: Json, where: string, strict: boolean): PriceRates {
  const input = rate(c.input, `${where} input`);
  const orInput = (v: unknown, name: string) => (!strict && v === undefined ? input : rate(v, `${where} ${name}`));
  return { input, output: rate(c.output, `${where} output`), cacheRead: orInput(c.cache_read, "cache_read"), cacheWrite: orInput(c.cache_write, "cache_write") };
}

/** OpenAI and Google models that are not chat models a coding agent runs (images, speech, embeddings, realtime). */
const NOT_A_CHAT_MODEL = /(image|realtime|audio|tts|transcribe|embedding|live|translate|search)/;

/** What each provider's models.dev entry contributes: the ids its family owns, and how strictly rates are read. */
const SOURCES: { provider: PriceProvider; strict: boolean; keep: (id: string) => boolean }[] = [
  { provider: "anthropic", strict: true, keep: (id) => providerOfId(id) === "anthropic" },
  { provider: "openai", strict: false, keep: (id) => providerOfId(id) === "openai" && !NOT_A_CHAT_MODEL.test(id) },
  { provider: "google", strict: false, keep: (id) => providerOfId(id) === "google" && !NOT_A_CHAT_MODEL.test(id) },
];

/**
 * models.dev's catalog to our table, ids sorted. Keeps each provider's own family (`claude-*`; `gpt-*` and `o<n>`
 * chat models; `gemini-*` chat models) with a `cost`. A tier must be `type: "context"` (the prompt size, by which
 * src/pricing.ts bills the whole call); any other tier type throws, so a new kind of pricing is never silently
 * priced as something it is not.
 */
export function fromModelsDev(api: unknown): Snapshot {
  const prices: PriceTable = {};
  let snapshot = "";
  for (const { provider, strict, keep } of SOURCES) {
    const models = (api as Json | undefined)?.[provider]?.models as Json | undefined;
    if (!models || typeof models !== "object") throw new Error(`models.dev: no ${provider}.models in the catalog (schema change?)`);
    let kept = 0;
    for (const [key, m] of Object.entries(models) as [string, Json][]) {
      const id: unknown = m?.id ?? key;
      if (typeof id !== "string" || !keep(id) || !m.cost) continue;
      prices[id] = priceOf(m, id, strict);
      kept += 1;
      if (typeof m.last_updated === "string" && m.last_updated > snapshot) snapshot = m.last_updated;
    }
    if (kept === 0) throw new Error(`models.dev: no priced ${provider} models (schema change?)`);
  }
  return { prices: sortTable(prices), snapshot };
}

function priceOf(m: Json, id: string, strict: boolean): ModelPrice {
  const price: ModelPrice = ratesOf(m.cost, id, strict);
  const tiers: unknown = m.cost.tiers;
  if (tiers !== undefined) {
    if (!Array.isArray(tiers)) throw new Error(`${id}: cost.tiers is not a list`);
    const list = tiers.map((t: Json, i): PriceTier => {
      const where = `${id} tier ${i}`;
      if (t?.tier?.type !== "context") throw new Error(`${where}: unknown tier type ${JSON.stringify(t?.tier?.type)}; teach src/pricing.ts about it before updating`);
      const above: unknown = t.tier.size;
      if (typeof above !== "number" || !Number.isInteger(above) || above <= 0) throw new Error(`${where}: tier size ${JSON.stringify(above)} is not a positive integer`);
      return { above, ...ratesOf(t, where, strict) };
    });
    if (list.length) price.tiers = list.sort((a, b) => a.above - b.above);
  }
  return price;
}

const sortTable = (t: PriceTable): PriceTable => Object.fromEntries(Object.keys(t).sort().map((id) => [id, t[id]!]));
const rates = (p: PriceRates) => RATE_KEYS.map((k) => `${k}: ${p[k]}`).join(", ");
const entry = (p: ModelPrice) => (p.tiers?.length ? `{ ${rates(p)}, tiers: [${p.tiers.map((t) => `{ above: ${t.above}, ${rates(t)} }`).join(", ")}] }` : `{ ${rates(p)} }`);

/** The generated file's tables, one per provider, in this order. */
const TABLE_NAMES: Record<PriceProvider, string> = { anthropic: "ANTHROPIC_PRICES", openai: "OPENAI_PRICES", google: "GOOGLE_PRICES" };

/** The text of src/pricing-data.ts. Deterministic: the same snapshot always gives the same bytes. */
export function renderTable({ prices, snapshot }: Snapshot): string {
  const tables = (Object.entries(TABLE_NAMES) as [PriceProvider, string][]).map(([provider, name]) => {
    const body = Object.keys(prices)
      .filter((id) => providerOfId(id) === provider)
      .sort()
      .map((id) => `  ${JSON.stringify(id)}: ${entry(prices[id]!)},`)
      .join("\n");
    return `export const ${name}: Record<string, ModelPrice> = {\n${body}\n};\n`;
  });
  return `// Generated by scripts/update-prices.ts from models.dev (snapshot ${snapshot || "undated"}). Do not edit by hand.
// USD per million tokens at each provider's list price. Anthropic: \`cacheWrite\` is the 5-minute rate (1-hour writes
// cost 2x \`input\`). OpenAI and Google: a cache rate models.dev does not list is the input rate.
// \`tiers\`: long-context rates for the whole call once its prompt is larger than \`above\` tokens (see src/pricing.ts).

import type { ModelPrice } from "./pricing.js";

${tables.join("\n")}`;
}

/**
 * The prices in a generated src/pricing-data.ts, read back from its text as one flat table (one `"id": { ... },`
 * line per model, as this generator writes them, now and before tiers). `ANTHROPIC_PRICES` must be there; the OpenAI
 * and Google tables are absent from files generated before they existed. Throws on anything else, so a
 * hand-reformatted file fails loudly instead of reading as empty.
 */
export function parseTable(text: string): PriceTable {
  const prices: PriceTable = {};
  for (const name of Object.values(TABLE_NAMES)) {
    const start = text.indexOf(`${name}: Record<string, ModelPrice> = {`);
    if (start < 0) {
      if (name === TABLE_NAMES.anthropic) throw new Error(`no ${name} table found`);
      continue;
    }
    const end = text.indexOf("\n};", start);
    for (const line of text.slice(start, end < 0 ? undefined : end).split("\n").slice(1)) {
      const m = /^\s*("[^"]+"):\s*(\{.*\}),\s*$/.exec(line);
      if (!m) {
        if (line.trim() && !line.trim().startsWith("//")) throw new Error(`${name}: cannot read line ${JSON.stringify(line.trim())}`);
        continue;
      }
      prices[JSON.parse(m[1]!) as string] = JSON.parse(m[2]!.replace(/([{,]\s*)([A-Za-z]\w*)\s*:/g, '$1"$2":')) as ModelPrice;
    }
  }
  return prices;
}

const sameTiers = (a: ModelPrice, b: ModelPrice) => JSON.stringify(a.tiers ?? []) === JSON.stringify(b.tiers ?? []);
const samePrice = (a: ModelPrice, b: ModelPrice) => RATE_KEYS.every((k) => a[k] === b[k]) && sameTiers(a, b);

export interface TableDiff {
  added: string[];
  removed: string[];
  /** Each changed field as `[before, after]`; `tiers` holds the whole list on each side. */
  changed: { id: string; fields: Record<string, [unknown, unknown]> }[];
}

export function diffTables(before: PriceTable, after: PriceTable): TableDiff {
  const added = Object.keys(after).filter((id) => !(id in before)).sort();
  const removed = Object.keys(before).filter((id) => !(id in after)).sort();
  const changed: TableDiff["changed"] = [];
  for (const id of Object.keys(after).sort()) {
    const a = before[id];
    const b = after[id]!;
    if (!a || samePrice(a, b)) continue;
    const fields: Record<string, [unknown, unknown]> = {};
    for (const k of RATE_KEYS) if (a[k] !== b[k]) fields[k] = [a[k], b[k]];
    if (!sameTiers(a, b)) fields.tiers = [a.tiers ?? [], b.tiers ?? []];
    changed.push({ id, fields });
  }
  return { added, removed, changed };
}

/**
 * Generated ids that would shadow a hand-kept supplemental price with different numbers. `findPrice` reads the
 * generated table first, by exact id and then by family (the id without a date stamp), so a generated entry for a
 * supplemental family would silently replace it.
 */
export function shadowedSupplements(prices: PriceTable, supplemental: PriceTable): string[] {
  const familyOf = (id: string) => id.replace(/-(\d{8}|latest)$/, "").replace(/-0$/, "");
  return Object.entries(prices)
    .filter(([id, p]) => {
      const s = supplemental[id] ?? supplemental[familyOf(id)];
      return s !== undefined && !samePrice(p, s);
    })
    .map(([id]) => id)
    .sort();
}

/** Per token to per million, rounded so float noise (3e-6 * 1e6 = 2.9999999999999996) does not read as a difference. */
const perMillion = (v: unknown): number | undefined => (typeof v === "number" ? Math.round(v * 1e12) / 1e6 : undefined);

export interface Disagreement {
  id: string;
  field: string;
  /** Undefined: models.dev has no such tier. */
  ours?: number;
  /** Undefined: LiteLLM does not list this rate or tier. */
  litellm?: number;
}
export interface CrossCheck {
  disagreements: Disagreement[];
  /** Ids only one source lists (informational: LiteLLM keeps dated aliases and models models.dev dropped). */
  onlyOurs: string[];
  onlyLitellm: string[];
}

/** Where LiteLLM keeps each provider's own entries: `litellm_provider`, and the key for one of our ids. */
const LITELLM_SOURCE: Record<PriceProvider, { provider: string; prefix: string }> = {
  anthropic: { provider: "anthropic", prefix: "" },
  openai: { provider: "openai", prefix: "" },
  google: { provider: "gemini", prefix: "gemini/" },
};

/**
 * Compare the table with LiteLLM's entries for the same providers: base rates, every tier's rates
 * (`*_above_<size/1000>k_tokens`), and for Anthropic the 1-hour write (`cache_creation_input_token_cost_above_1hr`,
 * per tier too), which should be 2x input. A tier only one side lists, or a rate LiteLLM leaves out, is a
 * disagreement (`litellm` undefined), except an OpenAI or Google cache rate LiteLLM leaves out where ours is the input
 * rate: the generator reads a missing cache rate the same way. Only models both list are compared; `onlyLitellm`
 * names LiteLLM models of the families the generator keeps.
 */
export function crossCheck(prices: PriceTable, litellm: unknown): CrossCheck {
  const theirs: Record<string, Json> = {};
  const unmatched = new Set<string>();
  for (const [key, m] of Object.entries((litellm ?? {}) as Json) as [string, Json][]) {
    const provider = (Object.keys(LITELLM_SOURCE) as PriceProvider[]).find((p) => LITELLM_SOURCE[p].provider === m?.litellm_provider);
    if (!provider || !key.startsWith(LITELLM_SOURCE[provider].prefix)) continue;
    const id = key.slice(LITELLM_SOURCE[provider].prefix.length);
    if (!SOURCES.find((s) => s.provider === provider)!.keep(id)) continue;
    theirs[id] = m;
    // A dated alias of a model we list (`gpt-5.1-2025-11-13`) is priced through that model: not worth naming.
    if (!(id.replace(/-(\d{4}-\d{2}-\d{2}|\d{8})$/, "") in prices)) unmatched.add(id);
  }
  const disagreements: Disagreement[] = [];
  for (const [id, p] of Object.entries(prices)) {
    const m = theirs[id];
    if (!m) continue;
    unmatched.delete(id);
    const anthropic = providerOfId(id) === "anthropic";
    // A rate LiteLLM does not list (or lists as something other than a number) is a disagreement too, so a
    // partial comparison never reads as agreement.
    const compare = (field: string, ours: number, value: unknown, absentMeans?: number) => {
      if (value === undefined && absentMeans !== undefined && Math.abs(absentMeans - ours) <= 1e-9) return;
      const v = perMillion(value);
      if (v === undefined || !Number.isFinite(v)) disagreements.push({ id, field, ours });
      else if (Math.abs(v - ours) > 1e-9) disagreements.push({ id, field, ours, litellm: v });
    };
    const levels = [{ suffix: "", name: "", r: p as PriceRates }, ...(p.tiers ?? []).map((t) => ({ suffix: `_above_${t.above / 1000}k_tokens`, name: ` above ${t.above / 1000}k`, r: t as PriceRates }))];
    for (const { suffix, name, r } of levels) {
      if (suffix && m[`input_cost_per_token${suffix}`] === undefined) {
        // LiteLLM would price the whole call at the base rate.
        disagreements.push({ id, field: `tier${name}`, ours: r.input });
        continue;
      }
      const noCacheRate = anthropic ? undefined : r.input;
      compare(`input${name}`, r.input, m[`input_cost_per_token${suffix}`]);
      compare(`output${name}`, r.output, m[`output_cost_per_token${suffix}`]);
      compare(`cacheRead${name}`, r.cacheRead, m[`cache_read_input_token_cost${suffix}`], noCacheRate);
      compare(`cacheWrite${name}`, r.cacheWrite, m[`cache_creation_input_token_cost${suffix}`], noCacheRate);
      if (anthropic) compare(`1h cacheWrite${name}`, r.input * CACHE_WRITE_1H_INPUT_MULTIPLIER, m[`cache_creation_input_token_cost_above_1hr${suffix}`]);
    }
    for (const key of Object.keys(m)) {
      const k = /^input_cost_per_token_above_(\d+)k_tokens$/.exec(key);
      if (k && !(p.tiers ?? []).some((t) => t.above === Number(k[1]) * 1000)) disagreements.push({ id, field: `tier above ${k[1]}k`, litellm: perMillion(m[key]) });
    }
  }
  return {
    disagreements,
    onlyOurs: Object.keys(prices).filter((id) => !theirs[id]).sort(),
    onlyLitellm: [...unmatched].sort(),
  };
}

const money = (v: unknown) => (typeof v === "number" ? `$${v}` : "–");
const ratesCell = (p: PriceRates) => `${money(p.input)} / ${money(p.output)} / ${money(p.cacheRead)} / ${money(p.cacheWrite)}`;
const tiersCell = (tiers: readonly PriceTier[] | undefined) => (tiers?.length ? tiers.map((t) => `above ${t.above / 1000}k: ${ratesCell(t)}`).join("<br>") : "");

/** What the update bot needs from a generator run (the `--json` summary). */
export interface PrBodySummary extends TableDiff {
  snapshot: string;
  prices: PriceTable;
  crossCheck: CrossCheck | null;
  crossCheckError?: string;
}

/** The body of the bot's "update model price table" PR. */
export function renderPrBody(s: PrBodySummary, opts: { tests: "pass" | "fail"; runUrl: string; base: string }): string {
  const lines: string[] = [];
  if (opts.tests === "fail") lines.push("> [!WARNING]", "> Typecheck or tests **fail** with this table. See the run log and CI below before merging.", "");
  lines.push(`Regenerated \`src/pricing-data.ts\` from [models.dev](https://models.dev) (snapshot **${s.snapshot}**) by [this run](${opts.runUrl}). USD per million tokens: input / output / cache read / 5-minute cache write.`, "");
  const rows: string[] = [];
  for (const id of s.added) rows.push(`| \`${id}\` | added | ${ratesCell(s.prices[id]!)} | ${tiersCell(s.prices[id]!.tiers)} |`);
  for (const c of s.changed) {
    const what = Object.entries(c.fields)
      .map(([k, [a, b]]) => (k === "tiers" ? "tiers changed" : `${k} ${money(a)} → ${money(b)}`))
      .join(", ");
    rows.push(`| \`${c.id}\` | ${what} | ${ratesCell(s.prices[c.id]!)} | ${tiersCell(s.prices[c.id]!.tiers)} |`);
  }
  for (const id of s.removed) rows.push(`| \`${id}\` | removed | | |`);
  if (rows.length) lines.push("| model | change | now | long-context tiers |", "| --- | --- | --- | --- |", ...rows, "");
  else lines.push("No price changed (header or format only).", "");

  lines.push("### LiteLLM cross-check", "");
  if (s.crossCheckError) lines.push(`Skipped: ${s.crossCheckError}`);
  else if (!s.crossCheck) lines.push("Skipped.");
  else {
    const d = s.crossCheck.disagreements;
    if (d.length) {
      lines.push(`**${d.length} disagreement${d.length === 1 ? "" : "s"}** (models.dev is used; check the provider's pricing page before merging):`, "", "| model | field | models.dev | LiteLLM |", "| --- | --- | --- | --- |");
      const listed = (v: number | undefined) => (v === undefined ? "not listed" : money(v));
      for (const x of d) lines.push(`| \`${x.id}\` | ${x.field} | ${listed(x.ours)} | ${listed(x.litellm)} |`);
    } else lines.push("No disagreements.");
    if (s.crossCheck.onlyOurs.length) lines.push("", `Only in models.dev: ${s.crossCheck.onlyOurs.map((id) => `\`${id}\``).join(", ")}`);
    if (s.crossCheck.onlyLitellm.length) lines.push("", `Only in LiteLLM: ${s.crossCheck.onlyLitellm.map((id) => `\`${id}\``).join(", ")}`);
  }
  lines.push(
    "",
    "### How to verify",
    "",
    `Compare the changed rows with the provider's pricing page ([Anthropic](https://platform.claude.com/docs/en/about-claude/pricing), [OpenAI](https://platform.openai.com/docs/pricing), [Google](https://ai.google.dev/gemini-api/docs/pricing)), and if you have local sessions on these models, run \`npm run audit:usage\` on this branch: Claude estimates should sit a little below Claude Code's \`cost-state\`, never above. Prices confirmed against \`cost-state\` are pinned in \`tests/pricing.vitest.ts\`; a failing pin means the source changed one of them.`,
    "",
    `This PR is kept up to date by \`.github/workflows/update-prices.yml\` (branch \`bot/update-prices\`, base \`${opts.base}\`): each run force-pushes it, and closes it once \`${opts.base}\` has the same prices.`,
  );
  return `${lines.join("\n")}\n`;
}
