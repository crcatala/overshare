import { describe, expect, it, vi } from "vitest";
import { markCacheEvents } from "../src/cache.js";
import { cacheWrite1hRate, estimateCost, findPrice, ratesFor, type ModelPrice } from "../src/pricing.js";
import type { ResponseUsage, Turn, Usage } from "../src/schema.js";

// Haiku 5.5 list prices (Anthropic, models.dev, LiteLLM agree): $0.10 / $0.50 / $0.01 / $0.125 per million up to a
// 100k-token prompt, $0.50 / $2.50 / $0.05 / $0.625 above. Added to the generated table here so these tests do not
// depend on when the table was last regenerated.
const { HAIKU, HAIKU_PRICE } = vi.hoisted(() => ({
  HAIKU: "claude-haiku-5-5",
  HAIKU_PRICE: {
    input: 0.1,
    output: 0.5,
    cacheRead: 0.01,
    cacheWrite: 0.125,
    tiers: [{ above: 100_000, input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 }],
  } satisfies ModelPrice,
}));
vi.mock("../src/pricing-data.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/pricing-data.js")>();
  return { ...actual, ANTHROPIC_PRICES: { ...actual.ANTHROPIC_PRICES, [HAIKU]: HAIKU_PRICE } };
});

const usage = (u: Partial<Usage>): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, ...u });

describe("long-context price tiers", () => {
  it("bills a call at the base rates up to the threshold and the whole call at the tier rates above it", () => {
    // Prompt = input + cacheRead + cacheWrite. Exactly 100,000 is not above the threshold.
    const at = usage({ input: 10, cacheRead: 90_000, cacheWrite: 9_990, output: 1_000 });
    expect(estimateCost(HAIKU, at)).toBeCloseTo((10 * 0.1 + 90_000 * 0.01 + 9_990 * 0.125 + 1_000 * 0.5) / 1e6, 12);
    // One token more and every token of the call, output included, is at the upper tier (not only the excess).
    const over = usage({ input: 11, cacheRead: 90_000, cacheWrite: 9_990, output: 1_000 });
    expect(estimateCost(HAIKU, over)).toBeCloseTo((11 * 0.5 + 90_000 * 0.05 + 9_990 * 0.625 + 1_000 * 2.5) / 1e6, 12);
    // Output does not count towards the prompt size.
    expect(estimateCost(HAIKU, usage({ input: 1_000, output: 200_000 }))).toBeCloseTo((1_000 * 0.1 + 200_000 * 0.5) / 1e6, 12);
  });

  it("prices 5-minute and 1-hour writes in the upper tier, the 1-hour rate at twice the tier's input", () => {
    const base = { input: 5, cacheRead: 150_000, output: 100 };
    // All 5-minute writes: $0.625.
    expect(estimateCost(HAIKU, usage({ ...base, cacheWrite: 20_000 }))).toBeCloseTo((5 * 0.5 + 150_000 * 0.05 + 20_000 * 0.625 + 100 * 2.5) / 1e6, 12);
    // All 1-hour writes: 2 x $0.50 = $1.00 (LiteLLM lists the same $1.00).
    expect(estimateCost(HAIKU, usage({ ...base, cacheWrite: 20_000, cacheWrite1h: 20_000 }))).toBeCloseTo((5 * 0.5 + 150_000 * 0.05 + 20_000 * 1 + 100 * 2.5) / 1e6, 12);
    // A split: 15,000 at 5 minutes, 5,000 at 1 hour.
    expect(estimateCost(HAIKU, usage({ ...base, cacheWrite: 20_000, cacheWrite1h: 5_000 }))).toBeCloseTo((5 * 0.5 + 150_000 * 0.05 + 15_000 * 0.625 + 5_000 * 1 + 100 * 2.5) / 1e6, 12);
    // Below the threshold the 1-hour rate is twice the base input.
    expect(estimateCost(HAIKU, usage({ cacheWrite: 1_000, cacheWrite1h: 1_000 }))).toBeCloseTo((1_000 * 0.2) / 1e6, 12);
  });

  it("picks the highest tier the prompt is above, whatever order the tiers are listed in", () => {
    const tier = (above: number, input: number) => ({ above, input, output: input * 5, cacheRead: input / 10, cacheWrite: input * 1.25 });
    const p: ModelPrice = { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25, tiers: [tier(500_000, 4), tier(100_000, 2)] };
    expect(ratesFor(p, usage({ input: 100_000 })).input).toBe(1);
    expect(ratesFor(p, usage({ input: 100_001 })).input).toBe(2);
    expect(ratesFor(p, usage({ input: 500_000 })).input).toBe(2);
    expect(ratesFor(p, usage({ cacheRead: 500_001 })).input).toBe(4);
    expect(cacheWrite1hRate(ratesFor(p, usage({ cacheRead: 500_001 })))).toBe(8);
  });

  it("leaves models without tiers at their one rate, however large the prompt", () => {
    const opus = findPrice("claude-opus-5-5")!;
    expect(opus.tiers).toBeUndefined();
    const big = usage({ input: 10, cacheRead: 900_000, cacheWrite: 50_000, output: 2_000 });
    expect(ratesFor(opus, big)).toBe(opus);
    expect(estimateCost("claude-opus-5-5", big)).toBeCloseTo((10 * 4 + 900_000 * 0.2 + 50_000 * 5 + 2_000 * 20) / 1e6, 12);
  });

  it("finds the tiered price through the same id decorations as any other model", () => {
    for (const id of [HAIKU, `${HAIKU}[1m]`, `anthropic/${HAIKU}`, `${HAIKU}-20261101`]) expect(findPrice(id), id).toEqual(HAIKU_PRICE);
  });

  it("prices a cache miss in the upper tier at that tier's write and read rates", () => {
    // Two calls of 150,005 prompt tokens; the second re-writes 140,000 it could have read.
    const call = (id: string, u: Usage): ResponseUsage => ({ id, turn: 0, model: HAIKU, usage: u });
    const responses = [call("a", usage({ input: 5, cacheWrite: 150_000, output: 50 })), call("b", usage({ input: 5, cacheRead: 10_000, cacheWrite: 140_000, output: 50 }))];
    const turn: Turn = { index: 0, steps: responses.map((r, i) => ({ kind: "text" as const, id: `t${i}`, responseId: r.id, text: "x" })) };
    markCacheEvents({ responses, turns: [turn] });
    const e = responses[1]!.cacheEvent!;
    expect(e).toMatchObject({ kind: "miss", recached: 140_005 });
    // Paid: 140,000 at $0.625 and 5 at $0.50, instead of all 140,005 read at $0.05.
    expect(e.cost).toBeCloseTo((140_000 * 0.625 + 5 * 0.5 - 140_005 * 0.05) / 1e6, 9);
  });
});
