import { describe, expect, it } from "vitest";
import { ANTHROPIC_PRICES, GOOGLE_PRICES, OPENAI_PRICES } from "../src/pricing-data.js";
import { estimateCost, findPrice, priceProvider, providerOfId, type ModelPrice } from "../src/pricing.js";
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
    expect(findPrice("claude-unreleased-9")).toBeUndefined();
    expect(findPrice("gpt-99-unreleased")).toBeUndefined();
    expect(findPrice("gemini-99-unreleased-high")).toBeUndefined();
    // Families we keep no price list for, wherever they are served.
    for (const id of ["z-ai/glm-5.3-flash", "grok-4.6", "deepseek/deepseek-v4.1-flash", "openrouter/z-ai/glm-5.3-flash:high", "solo3"]) expect(findPrice(id), id).toBeUndefined();
    expect(estimateCost("claude-unreleased-9", usage({ input: 1000 }))).toBeUndefined();
  });

  it("finds OpenAI ids as Codex and pi write them, and Gemini ids with Antigravity's thinking level", () => {
    const sol = OPENAI_PRICES["gpt-6.1-sol"];
    expect(sol).toEqual({ input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5, tiers: [{ above: 272_000, input: 4, output: 15, cacheRead: 0.2, cacheWrite: 5 }] });
    for (const id of ["gpt-6.1-sol", "GPT-6.1-Sol", "openai/gpt-6.1-sol", "openai-codex/gpt-6.1-sol:high", "openrouter/openai/gpt-6.1-sol"]) expect(findPrice(id), id).toEqual(sol);
    expect(findPrice("gpt-5.6-terra")).toEqual(OPENAI_PRICES["gpt-5.6-terra"]);
    expect(findPrice("o3")).toEqual(OPENAI_PRICES["o3"]);
    // A dated OpenAI id falls back to the undated one.
    expect(findPrice("gpt-6.1-sol-2026-09-29")).toEqual(sol);
    const neon = GOOGLE_PRICES["gemini-4-neon"];
    expect(neon).toEqual({ input: 3, output: 15, cacheRead: 0.15, cacheWrite: 3 });
    for (const id of ["gemini-4-neon", "gemini-4-neon-high", "gemini-4-neon-medium", "gemini-4-neon-low", "google/gemini-4-neon"]) expect(findPrice(id), id).toEqual(neon);
    // An id that is itself listed wins over stripping a suffix from it.
    expect(findPrice("gemini-flash-latest")).toEqual(GOOGLE_PRICES["gemini-flash-latest"]);
  });

  it("says whose price list a model is on, which is what tells an explicit cache", () => {
    expect(priceProvider("claude-opus-5-5")).toBe("anthropic");
    expect(priceProvider("us.anthropic.claude-opus-5-5-v1:0")).toBe("anthropic");
    expect(priceProvider("gpt-6.1-sol")).toBe("openai");
    expect(priceProvider("gpt-5.1-codex")).toBe("openai");
    expect(priceProvider("gemini-4-neon-high")).toBe("google");
    // Unpriced: no provider, even for a family we know.
    expect(priceProvider("claude-unreleased-9")).toBeUndefined();
    expect(priceProvider("grok-4.6")).toBeUndefined();
    expect(providerOfId("o4-mini")).toBe("openai");
    expect(providerOfId("o4x")).toBeUndefined();
  });

  it("prices OpenAI cache reads at the cached-input rate, with the long-context tier", () => {
    // 10,000 uncached + 90,000 cached input, 2,000 output on GPT-6.1 Sol: 10,000*2 + 90,000*0.1 + 2,000*10.
    expect(estimateCost("gpt-6.1-sol", usage({ input: 10_000, cacheRead: 90_000, output: 2_000 }))).toBeCloseTo((20_000 + 9_000 + 20_000) / 1e6, 12);
    // Over 272k of prompt the whole call is billed at the tier: 10,000*4 + 270,000*0.2 + 2,000*15.
    expect(estimateCost("gpt-6.1-sol", usage({ input: 10_000, cacheRead: 270_000, output: 2_000 }))).toBeCloseTo((40_000 + 54_000 + 30_000) / 1e6, 12);
    // Gemini through Antigravity's id: 6,501*3 + 35,192*0.15 + 223*15.
    expect(estimateCost("gemini-4-neon-high", usage({ input: 6_501, cacheRead: 35_192, output: 223 }))).toBeCloseTo((19_503 + 5_278.8 + 3_345) / 1e6, 9);
  });

  it("prices the Codex variants models.dev does not list from the hand-kept supplement", () => {
    expect(findPrice("gpt-5.1-codex")).toEqual({ input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 1.25 });
    expect(findPrice("gpt-5.1-codex-mini")).toMatchObject({ input: 0.25, output: 2 });
    expect(findPrice("openai/gpt-5.2-codex")).toMatchObject({ input: 1.75, output: 14 });
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

  it("reads a cache rate models.dev leaves out as the input rate, never as free", () => {
    // GPT-5 Pro lists no cache rates: cached tokens cost what input does.
    expect(OPENAI_PRICES["gpt-5-pro"]).toMatchObject({ input: 15, cacheRead: 15, cacheWrite: 15 });
    for (const [id, price] of Object.entries({ ...OPENAI_PRICES, ...GOOGLE_PRICES })) {
      for (const p of [price, ...(price.tiers ?? [])]) {
        expect(p.input, id).toBeGreaterThan(0);
        expect(p.output, id).toBeGreaterThan(0);
        expect(p.cacheRead, id).toBeLessThanOrEqual(p.input);
        expect(p.cacheWrite, id).toBeGreaterThanOrEqual(p.input);
      }
    }
  });

  it("keeps each provider's own family in its table", () => {
    for (const [provider, table] of [["anthropic", ANTHROPIC_PRICES], ["openai", OPENAI_PRICES], ["google", GOOGLE_PRICES]] as const) {
      expect(Object.keys(table).length, provider).toBeGreaterThan(0);
      for (const id of Object.keys(table)) expect(providerOfId(id), id).toBe(provider);
    }
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
