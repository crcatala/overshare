import { ANTHROPIC_PRICES } from "./pricing-data.js";
import { contextTokens, type Usage } from "./schema.js";

/** USD per million tokens at Anthropic list price; `cacheWrite` is the 5-minute rate (1-hour writes cost 2x `input`). */
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

const PRICES: Record<string, ModelPrice> = ANTHROPIC_PRICES;

/**
 * Older models neither models.dev nor LiteLLM lists (so the generated table lacks them), kept by
 * hand from Anthropic's published list prices. Keyed by family, without date stamps. Kept apart
 * from `pricing-data.ts` so `scripts/update-prices.ts` cannot overwrite it; the generator refuses
 * to emit an id that would shadow one of these with different prices.
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
};

/**
 * List price for a Claude model id. Tolerates the suffixes and prefixes that show up in
 * transcripts: `[1m]` context markers, Bedrock/Vertex wrappers, `-v1:0`, and date stamps.
 */
export function findPrice(model: string | undefined): ModelPrice | undefined {
  if (!model) return undefined;
  const id = /claude-[a-z0-9.-]+/.exec(model.toLowerCase())?.[0]?.replace(/-v\d+$/, "");
  if (!id) return undefined;
  const family = id.replace(/-(\d{8}|latest)$/, "").replace(/-0$/, "");
  return PRICES[id] ?? PRICES[family] ?? SUPPLEMENTAL_PRICES[family];
}

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
