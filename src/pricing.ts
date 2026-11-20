import { ANTHROPIC_PRICES, GOOGLE_PRICES, OPENAI_PRICES } from "./pricing-data.js";
import { contextTokens, type Usage } from "./schema.js";

/**
 * USD per million tokens at the provider's list price. For Anthropic `cacheWrite` is the 5-minute rate (1-hour writes
 * cost 2x `input`); for OpenAI and Google it is what models.dev lists, else the input rate (no write premium).
 */
export interface PriceRates {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/**
 * Long-context rates: they replace the base rates for the whole call when its prompt (`input + cacheRead +
 * cacheWrite`, the same quantity as peak context) is larger than `above` tokens. Not only the tokens past the
 * threshold: on local Haiku 5.5 sessions this reproduces Claude Code's own `cost-state` exactly, and pricing only
 * the excess does not (ove-xxsk).
 */
export interface PriceTier extends PriceRates {
  above: number;
}

export interface ModelPrice extends PriceRates {
  /** Sorted ascending by `above`. Absent for a model with one flat rate. */
  tiers?: readonly PriceTier[];
}

/** Anthropic bills 1-hour cache writes at twice the input rate (5-minute writes have their own rate), in every tier. */
const CACHE_WRITE_1H_INPUT_MULTIPLIER = 2;

/** USD per million tokens for a 1-hour cache write at these rates. */
export const cacheWrite1hRate = (p: PriceRates): number => p.input * CACHE_WRITE_1H_INPUT_MULTIPLIER;

/** The rates one call is billed at: the highest tier its prompt is larger than, else the base rates. */
export function ratesFor(p: ModelPrice, u: Usage): PriceRates {
  const prompt = contextTokens(u);
  let rates: PriceRates = p;
  let above = -1;
  for (const t of p.tiers ?? []) {
    if (prompt > t.above && t.above > above) {
      rates = t;
      above = t.above;
    }
  }
  return rates;
}

/** Whose price list a model is on. Only Anthropic models cache explicitly by definition (see `cache.ts`). */
export type PriceProvider = "anthropic" | "openai" | "google";

const TABLES: Record<PriceProvider, Record<string, ModelPrice>> = { anthropic: ANTHROPIC_PRICES, openai: OPENAI_PRICES, google: GOOGLE_PRICES };

/**
 * The provider a bare model id belongs to, by its family: `claude-*`, `gemini-*`, or OpenAI's `gpt-*`, `o<n>`,
 * `codex-*` and `chatgpt-*`. The price generator keeps only these families, so an id's table follows from the id.
 */
export function providerOfId(id: string): PriceProvider | undefined {
  if (id.startsWith("claude-")) return "anthropic";
  if (id.startsWith("gemini-")) return "google";
  if (/^(gpt-|codex-|chatgpt-|o\d+(-|$))/.test(id)) return "openai";
  return undefined;
}

/**
 * Models the generated table lacks, kept by hand from the provider's published list prices: older Claude models
 * neither models.dev nor LiteLLM lists (keyed by family, without date stamps), and the OpenAI Codex variants Codex
 * sessions name that models.dev does not list (rates as LiteLLM and OpenAI's pricing page give them; OpenAI bills no
 * cache-write premium, so `cacheWrite` is the input rate). The provider follows from the id (`providerOfId`). Kept apart
 * from `pricing-data.ts` so `scripts/update-prices.ts` cannot overwrite it; the generator refuses to emit an id that
 * would shadow one of these with different prices.
 */
export const SUPPLEMENTAL_PRICES: Record<string, ModelPrice> = {
  "claude-3-haiku": { input: 0.25, output: 1.25, cacheRead: 0.03, cacheWrite: 0.3 },
  "claude-3-5-haiku": { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
  "claude-3-5-sonnet": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-3-7-sonnet": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-sonnet-4": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-3-opus": { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  "claude-opus-4": { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  "claude-opus-4-1": { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  "gpt-5-codex": { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 1.25 },
  "gpt-5.1-codex": { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 1.25 },
  "gpt-5.1-codex-max": { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 1.25 },
  "gpt-5.1-codex-mini": { input: 0.25, output: 2, cacheRead: 0.025, cacheWrite: 0.25 },
  "gpt-5.2-codex": { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 1.75 },
};

/** A Gemini id as Antigravity writes it carries the thinking level (`gemini-4-neon-high`); the price is the base model's. */
const THINKING_LEVEL = /-(minimal|low|medium|high|max|none)$/;
const DATE_STAMP = /-(\d{4}-\d{2}-\d{2}|\d{8}|latest)$/;

/**
 * The price list entry for a model id as a transcript writes it, and whose list it is on.
 *
 * Claude ids are found anywhere in the string, tolerating the suffixes and prefixes that show up in transcripts:
 * `[1m]` context markers, Bedrock/Vertex wrappers, `-v1:0`, and date stamps. Other ids are the last path segment
 * (`openai/`, `openai-codex/`, `openrouter/openai/`) without a `:variant` (`:high`), tried as written, then without a
 * date stamp, then (Gemini) without a thinking level.
 */
export function lookupPrice(model: string | undefined): { provider: PriceProvider; price: ModelPrice } | undefined {
  if (!model) return undefined;
  const lower = model.toLowerCase();
  const claude = /claude-[a-z0-9.-]+/.exec(lower)?.[0]?.replace(/-v\d+$/, "");
  if (claude) {
    const family = claude.replace(/-(\d{8}|latest)$/, "").replace(/-0$/, "");
    const price = ANTHROPIC_PRICES[claude] ?? ANTHROPIC_PRICES[family] ?? SUPPLEMENTAL_PRICES[family];
    return price && { provider: "anthropic", price };
  }
  const id = (lower.split("/").at(-1) ?? "").replace(/\[[^\]]*\]$/, "").split(":")[0]!.trim();
  const provider = providerOfId(id);
  if (!provider || provider === "anthropic") return undefined;
  const candidates = [id, id.replace(DATE_STAMP, "")];
  if (provider === "google") candidates.push(id.replace(THINKING_LEVEL, ""), id.replace(DATE_STAMP, "").replace(THINKING_LEVEL, ""));
  for (const c of candidates) {
    const price = TABLES[provider][c] ?? SUPPLEMENTAL_PRICES[c];
    if (price) return { provider, price };
  }
  return undefined;
}

/** List price for a model id (see `lookupPrice`), or undefined for a model on no price list we have. */
export const findPrice = (model: string | undefined): ModelPrice | undefined => lookupPrice(model)?.price;

/** The provider of a model we have a price for: `cache.ts` asks this, not whether a price exists, to tell explicit caches. */
export const priceProvider = (model: string | undefined): PriceProvider | undefined => lookupPrice(model)?.provider;

/**
 * Cost in USD of one model call at list price, or undefined for a model we have no price
 * for (never 0: an unpriced call must not look free).
 *
 * Long-context tiers are applied where the price table lists them (`ratesFor`). Not modelled: the
 * fast-mode premium and regional (data residency) surcharges, which transcripts do not record, and
 * long-context premiums the table does not list. The estimate can therefore undercount, which
 * `describeCost` says.
 */
export function estimateCost(model: string | undefined, u: Usage): number | undefined {
  const price = findPrice(model);
  if (!price) return undefined;
  const p = ratesFor(price, u);
  const long = Math.min(u.cacheWrite1h ?? 0, u.cacheWrite);
  const short = u.cacheWrite - long;
  return (u.input * p.input + u.output * p.output + u.cacheRead * p.cacheRead + short * p.cacheWrite + long * cacheWrite1hRate(p)) / 1_000_000;
}
