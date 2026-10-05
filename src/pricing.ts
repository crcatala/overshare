import { ANTHROPIC_PRICES, type ModelPrice } from "./pricing-data.js";
import type { Usage } from "./schema.js";

export type { ModelPrice } from "./pricing-data.js";

/** Anthropic bills 1-hour cache writes at twice the base input rate (5-minute writes have their own rate). */
const CACHE_WRITE_1H_INPUT_MULTIPLIER = 2;

/** USD per million tokens for a 1-hour cache write of this model. */
export const cacheWrite1hRate = (p: ModelPrice): number => p.input * CACHE_WRITE_1H_INPUT_MULTIPLIER;

/**
 * Older models pi's catalog does not list (so the generated table lacks them), kept by hand
 * from Anthropic's published list prices. Keyed by family, without date stamps. Kept apart
 * from `pricing-data.ts` so `scripts/update-prices.mjs` cannot overwrite it.
 */
const SUPPLEMENTAL_PRICES: Record<string, ModelPrice> = {
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
  return ANTHROPIC_PRICES[id] ?? ANTHROPIC_PRICES[family] ?? SUPPLEMENTAL_PRICES[family];
}

/**
 * Cost in USD of one model call at list price, or undefined for a model we have no price
 * for (never 0: an unpriced call must not look free).
 *
 * Not modelled: the long-context (>200k) premium, the fast-mode premium and regional (data
 * residency) surcharges, none of which transcripts record. The estimate can therefore
 * undercount, which `describeCost` says.
 */
export function estimateCost(model: string | undefined, u: Usage): number | undefined {
  const p = findPrice(model);
  if (!p) return undefined;
  const long = Math.min(u.cacheWrite1h ?? 0, u.cacheWrite);
  const short = u.cacheWrite - long;
  return (u.input * p.input + u.output * p.output + u.cacheRead * p.cacheRead + short * p.cacheWrite + long * cacheWrite1hRate(p)) / 1_000_000;
}
