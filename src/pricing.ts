import { ANTHROPIC_PRICES, type ModelPrice } from "./pricing-data.js";
import type { Usage } from "./schema.js";

export type { ModelPrice } from "./pricing-data.js";

/** Anthropic bills 1-hour cache writes at twice the base input rate (5-minute writes have their own rate). */
const CACHE_WRITE_1H_INPUT_MULTIPLIER = 2;

/**
 * List price for a Claude model id. Tolerates the suffixes and prefixes that show up in
 * transcripts: `[1m]` context markers, Bedrock/Vertex wrappers, `-v1:0`, and date stamps.
 */
export function findPrice(model: string | undefined): ModelPrice | undefined {
  if (!model) return undefined;
  const id = /claude-[a-z0-9.-]+/.exec(model.toLowerCase())?.[0]?.replace(/-v\d+$/, "");
  if (!id) return undefined;
  return ANTHROPIC_PRICES[id] ?? ANTHROPIC_PRICES[id.replace(/-\d{8}$/, "")];
}

/**
 * Cost in USD of one model call at list price, or undefined for a model we have no price
 * for (never 0: an unpriced call must not look free).
 *
 * Not modelled: the fast-mode premium and regional (data residency) surcharges, which
 * transcripts do not record.
 */
export function estimateCost(model: string | undefined, u: Usage): number | undefined {
  const p = findPrice(model);
  if (!p) return undefined;
  const long = Math.min(u.cacheWrite1h ?? 0, u.cacheWrite);
  const short = u.cacheWrite - long;
  return (u.input * p.input + u.output * p.output + u.cacheRead * p.cacheRead + short * p.cacheWrite + long * p.input * CACHE_WRITE_1H_INPUT_MULTIPLIER) / 1_000_000;
}
