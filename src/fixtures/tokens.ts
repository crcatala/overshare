import type { Rng } from "./random.js";

export interface RawUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
}

const tokensFor = (chars: number) => Math.ceil(chars / 3.8);

/**
 * Plausible token usage for a growing conversation: each response re-reads the cached
 * prompt, writes the newly added content to cache, and adds its own output to the
 * context. Compaction resets the context to a short summary.
 */
export class TokenModel {
  private context = 0;
  private pending: number;

  constructor(
    private readonly rng: Rng,
    /** Anthropic-style prompt caching (cache writes) vs OpenAI-style (no cache writes). */
    private readonly style: "anthropic" | "openai",
    systemPromptTokens = 14_000,
  ) {
    this.pending = systemPromptTokens;
  }

  add(chars: number): void {
    this.pending += tokensFor(chars);
  }

  respond(outputChars: number, reasoning: number): RawUsage {
    const fresh = this.pending;
    const output = tokensFor(outputChars) + reasoning + this.rng.int(4, 30);
    const usage: RawUsage =
      this.style === "anthropic"
        ? { input: Math.min(fresh, this.rng.int(1, 12)), cacheWrite: Math.max(0, fresh - 12), cacheRead: this.context, output, reasoning }
        : { input: fresh, cacheWrite: 0, cacheRead: this.context, output, reasoning };
    this.context += fresh + output;
    this.pending = 0;
    return usage;
  }

  get contextTokens(): number {
    return this.context + this.pending;
  }

  compact(): void {
    this.context = 0;
    this.pending = this.rng.int(5_000, 9_000);
  }
}

/** Rough per-token prices (USD per million) for plausible cost numbers. */
export function costOf(u: RawUsage, prices = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }): number {
  return (u.input * prices.input + u.output * prices.output + u.cacheRead * prices.cacheRead + u.cacheWrite * prices.cacheWrite) / 1_000_000;
}
