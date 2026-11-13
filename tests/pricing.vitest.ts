import { describe, expect, it } from "vitest";
import { ANTHROPIC_PRICES } from "../src/pricing-data.js";
import { estimateCost, findPrice, type ModelPrice } from "../src/pricing.js";
import { emptyUsage } from "../src/schema.js";
import { CLAUDE_FIXTURE_MODEL } from "../src/fixtures/claude-code.js";

const usage = (over: Partial<ReturnType<typeof emptyUsage>>) => ({ ...emptyUsage(), ...over });

describe("pricing", () => {
  it("finds a price through the decorations model ids carry in transcripts", () => {
    const opus = ANTHROPIC_PRICES["claude-opus-5-5"];
    expect(opus).toEqual({ input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 });
    for (const id of ["claude-opus-5-5", "claude-opus-5-5[1m]", "Claude-Opus-5-5", "us.anthropic.claude-opus-5-5-v1:0", "anthropic/claude-opus-5-5"]) {
      expect(findPrice(id), id).toEqual(opus);
    }
    // A dated id falls back to its undated family when only that is listed.
    expect(findPrice("claude-opus-5-5-20260101")).toEqual(opus);
    expect(findPrice("claude-sonnet-4-5-20250929")).toEqual(ANTHROPIC_PRICES["claude-sonnet-4-5-20250929"]);
  });

  it("has no price for models it does not know, rather than a zero", () => {
    expect(findPrice(undefined)).toBeUndefined();
    expect(findPrice("<synthetic>")).toBeUndefined();
    expect(findPrice("gpt-5.6-terra")).toBeUndefined();
    expect(findPrice("claude-unreleased-9")).toBeUndefined();
    expect(estimateCost("claude-unreleased-9", usage({ input: 1000 }))).toBeUndefined();
  });

  it("prices each token kind, with 1-hour cache writes at twice the input rate", () => {
    const base = { input: 10, output: 50, cacheRead: 1000, cacheWrite: 200 };
    // 10*4 + 50*20 + 1000*0.2 + 200*5 (all 5-minute writes), per million.
    expect(estimateCost("claude-opus-5-5", usage(base))).toBeCloseTo(2240 / 1e6, 12);
    // The same writes at the 1h rate: 200 * 4 * 2.
    expect(estimateCost("claude-opus-5-5", usage({ ...base, cacheWrite1h: 200 }))).toBeCloseTo(2840 / 1e6, 12);
    // A split: 150 at 5m, 50 at 1h.
    expect(estimateCost("claude-opus-5-5", usage({ ...base, cacheWrite1h: 50 }))).toBeCloseTo((40 + 1000 + 200 + 750 + 400) / 1e6, 12);
    // Thinking tokens are part of output and are not priced twice.
    expect(estimateCost("claude-opus-5-5", usage({ ...base, reasoning: 30 }))).toBeCloseTo(2240 / 1e6, 12);
  });

  it("prices older models the sources lack from the hand-kept supplement", () => {
    const expected: Record<string, [number, number]> = {
      "claude-3-5-sonnet-20241022": [3, 15],
      "claude-3-5-sonnet-latest": [3, 15],
      "claude-3-7-sonnet-20250219": [3, 15],
      "claude-3-5-haiku-20241022": [0.8, 4],
      "claude-3-haiku-20240307": [0.25, 1.25],
      "claude-3-opus-20240229": [15, 75],
      "claude-sonnet-4-20250514": [3, 15],
      "claude-sonnet-4-0": [3, 15],
      "claude-opus-4-20250514": [15, 75],
      "claude-opus-4-1-20250805": [15, 75],
    };
    for (const [id, [input, output]] of Object.entries(expected)) expect(findPrice(id), id).toMatchObject({ input, output });
    // 15 + 75 + 1.5*1000/1e3... per million: 10*15 + 50*75 + 1000*1.5 + 200*18.75
    expect(estimateCost("claude-opus-4-1-20250805", usage({ input: 10, output: 50, cacheRead: 1000, cacheWrite: 200 }))).toBeCloseTo((150 + 3750 + 1500 + 3750) / 1e6, 12);
    // A 4.5 model must not be mistaken for the 4.0 family.
    expect(findPrice("claude-sonnet-4-5-20250929")).toEqual(ANTHROPIC_PRICES["claude-sonnet-4-5-20250929"]);
  });

  it("prices the model the generated Claude Code fixtures use", () => {
    expect(findPrice(CLAUDE_FIXTURE_MODEL)).toBeDefined();
  });

  it("lists only positive prices", () => {
    for (const [id, price] of Object.entries(ANTHROPIC_PRICES)) {
      for (const p of [price, ...(price.tiers ?? [])]) {
        expect(p.input, id).toBeGreaterThan(0);
        expect(p.output, id).toBeGreaterThan(p.input);
        expect(p.cacheRead, id).toBeLessThan(p.input);
        expect(p.cacheWrite, id).toBeGreaterThanOrEqual(p.input);
      }
      // Tiers are sorted, and each costs more than the one below it.
      let below: ModelPrice = price;
      for (const t of price.tiers ?? []) {
        expect(t.above, id).toBeGreaterThan(0);
        expect(t.input, id).toBeGreaterThan(below.input);
        below = t;
      }
    }
  });

  // Prices confirmed against Claude Code's own cost-state on local sessions. This guards against a typo in the
  // generated source, not against price changes: if Anthropic changes one of these, update it here on purpose.
  it("keeps the prices verified against Claude Code's cost-state", () => {
    expect(ANTHROPIC_PRICES["claude-opus-5-5"]).toEqual({ input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 });
    expect(ANTHROPIC_PRICES["claude-haiku-4-5"]).toEqual({ input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 });
    // Tiers confirmed in ove-xxsk (whole-call billing above a 100k-token prompt).
    expect(ANTHROPIC_PRICES["claude-haiku-5-5"]).toEqual({
      input: 0.1,
      output: 0.5,
      cacheRead: 0.01,
      cacheWrite: 0.125,
      tiers: [{ above: 100_000, input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 }],
    });
    // Opus 5.5 at both cache-write lifetimes: 1,000 tokens at $5 (5 minutes) and at $8 (1 hour).
    expect(estimateCost("claude-opus-5-5", usage({ cacheWrite: 1000 }))).toBeCloseTo(0.005, 12);
    expect(estimateCost("claude-opus-5-5", usage({ cacheWrite: 1000, cacheWrite1h: 1000 }))).toBeCloseTo(0.008, 12);
  });
});
