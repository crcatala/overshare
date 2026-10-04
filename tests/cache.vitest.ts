import { describe, expect, it } from "vitest";
import { parseClaudeCode } from "../src/harnesses/claude-code/parse.js";
import { parsePi } from "../src/harnesses/pi/parse.js";
import { MISS_RULE, markCacheEvents } from "../src/cache.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { prepareShare } from "../src/pipeline.js";
import { estimateCost } from "../src/pricing.js";
import { SHARE_MODES, type NormalizedSession, type ResponseUsage, type Step, type Turn, type Usage } from "../src/schema.js";
import { computeStats } from "../src/stats.js";
import { ClaudeTranscript, PiTranscript, ccUsage, piUsage } from "./helpers.js";

const OPUS = "claude-opus-5-5";
const T0 = Date.UTC(2026, 0, 1);
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();

interface Call {
  read?: number;
  write?: number;
  write1h?: number;
  input?: number;
  output?: number;
  model?: string;
  /** Minutes since the start of the session. */
  min?: number;
  purpose?: ResponseUsage["purpose"];
  inherited?: true;
  /** Steps that come before this call's own step in the transcript (a compaction event, say). */
  before?: Step[];
  /** The call has no step in the transcript (a call the transcript never shows). */
  noStep?: boolean;
  /** The cost the harness recorded for the call. */
  cost?: number;
}

const compaction: Step = { kind: "event", id: "c", event: "compaction", text: "Context compacted" };

/** A session of consecutive calls, one per turn step, with the transcript events between them. */
function session(calls: Call[], stats: Partial<NormalizedSession["stats"]> = {}, harness?: "claude-code" | "pi"): Pick<NormalizedSession, "responses" | "turns"> & { stats: NormalizedSession["stats"]; harness?: { name: "claude-code" | "pi" } } {
  const responses: ResponseUsage[] = [];
  const turn: Turn = { index: 0, steps: [] };
  calls.forEach((c, i) => {
    const id = `r${i}`;
    const usage: Usage = { input: c.input ?? 10, output: c.output ?? 50, cacheRead: c.read ?? 0, cacheWrite: c.write ?? 0, reasoning: 0, ...(c.write1h ? { cacheWrite1h: c.write1h } : {}), ...(c.cost !== undefined ? { cost: c.cost } : {}) };
    responses.push({ id, turn: 0, model: c.model ?? OPUS, ...(c.min !== undefined ? { timestamp: at(c.min) } : {}), usage, ...(c.purpose ? { purpose: c.purpose } : {}), ...(c.inherited ? { inherited: c.inherited } : {}) });
    turn.steps.push(...(c.before ?? []));
    if (!c.purpose && !c.noStep) turn.steps.push({ kind: "text", id: `t${i}`, responseId: id, text: "x" });
  });
  return { responses, turns: [turn], stats: { rates: undefined, ...stats } as NormalizedSession["stats"], ...(harness ? { harness: { name: harness } } : {}) };
}

const events = (s: ReturnType<typeof session>) => s.responses.map((r) => r.cacheEvent);

describe("cache miss detection", () => {
  it("does not flag a steady conversation that reads the previous prompt from cache", () => {
    const s = session([{ write: 30_000, read: 0 }, { read: 30_010, write: 500 }, { read: 30_510, write: 700 }]);
    const summary = markCacheEvents(s);
    expect(events(s)).toEqual([undefined, undefined, undefined]);
    expect(summary).toMatchObject({ requests: 3, misses: 0, rebuilds: 0, modelSwitches: 0 });
  });

  it("never flags the first call of a session", () => {
    const s = session([{ write: 90_000 }]);
    expect(markCacheEvents(s)).toMatchObject({ requests: 1, misses: 0 });
    expect(events(s)).toEqual([undefined]);
  });

  describe("thresholds (more than 5% and at least 2,000 tokens of what could have been read)", () => {
    // Previous prompt: 100,000 tokens (10 uncached + 99,990 written).
    const prev: Call = { write: 99_990 };
    const after = (recached: number) => {
      const s = session([prev, { read: 100_000 - recached, write: recached }]);
      markCacheEvents(s);
      return s.responses[1]!.cacheEvent;
    };

    it("flags a call that re-processed 6,000 of 100,000 tokens", () => {
      expect(after(6_000)).toMatchObject({ kind: "miss", recached: 6_000 });
    });

    it("does not flag 5,000 of 100,000: exactly 5% is not more than 5%", () => {
      expect(after(5_000)).toBeUndefined();
    });

    it("does not flag under 2,000 tokens even when that is over 5% of a small prompt", () => {
      const s = session([{ write: 10_000 }, { read: 8_500, write: 1_500 }]);
      markCacheEvents(s);
      expect(s.responses[1]!.cacheEvent).toBeUndefined();
    });

    it("flags exactly 2,000 tokens once that is more than 5%", () => {
      const s = session([{ input: 0, write: 20_000 }, { input: 0, read: 18_000, write: 2_000 }]);
      markCacheEvents(s);
      expect(s.responses[1]!.cacheEvent).toMatchObject({ kind: "miss", recached: 2_000 });
    });

    it("counts only what the previous prompt held: growth (new tool output) is not a miss", () => {
      // The new call adds 50,000 fresh tokens on top of a fully cached 100,000.
      const s = session([prev, { read: 100_000, write: 50_000 }]);
      markCacheEvents(s);
      expect(s.responses[1]!.cacheEvent).toBeUndefined();
    });

    it("caps what was re-processed at this call's own prompt (a context that shrank)", () => {
      // Rewinding to earlier work: the whole (smaller) prompt is read from cache, nothing was re-processed.
      const s = session([prev, { read: 40_000, write: 0 }]);
      markCacheEvents(s);
      expect(s.responses[1]!.cacheEvent).toBeUndefined();
      // Re-processing all of a smaller prompt is a miss of that size, not of the previous prompt's.
      const cold = session([prev, { input: 40_000, read: 0, write: 0 }]);
      markCacheEvents(cold);
      expect(cold.responses[1]!.cacheEvent).toMatchObject({ kind: "miss", recached: 40_000 });
    });

    it("uses a stricter rule for providers that never report cache writes (block-granular, best-effort caching)", () => {
      // OpenAI-style: a lag of one 2,304-token block is ordinary, a lost prefix is not.
      const m = "gpt-5.6-luna";
      const lag = session([{ input: 30_000, model: m }, { input: 5_000, read: 27_648, model: m }, { input: 4_000, read: 27_648, model: m }, { input: 9_000, read: 30_000, model: m }]);
      markCacheEvents(lag);
      expect(events(lag)).toEqual([undefined, undefined, undefined, undefined]);
      const lost = session([{ input: 30_000, read: 0, model: m }, { input: 500, read: 29_500, model: m }, { input: 32_000, read: 0, model: m }]);
      markCacheEvents(lost);
      expect(lost.responses[2]!.cacheEvent).toMatchObject({ kind: "miss", recached: 30_000 });
      expect(MISS_RULE.implicit.tokens).toBeGreaterThan(MISS_RULE.explicit.tokens);
    });

    it("treats a Claude model as explicit however few calls a short session has", () => {
      // 3 calls, one 6,000-token loss: enough to tell only because Anthropic caching is explicit by definition.
      const s = session([{ input: 0, write: 100_000 }, { input: 0, read: 100_000, write: 10 }, { input: 0, read: 94_000, write: 6_010 }]);
      markCacheEvents(s);
      expect(s.responses[2]!.cacheEvent).toMatchObject({ kind: "miss", recached: 6_010 });
    });

    it("does not let a stray write make another model's cache explicit: 1 write in 3 calls, or 1% of a long session", () => {
      const m = "gpt-5.6-terra";
      const short = session([{ input: 30_000, model: m }, { input: 3_000, read: 27_000, write: 10, model: m }, { input: 4_500, read: 28_500, model: m }]);
      markCacheEvents(short);
      // The 4,500-token lag would be a miss under the explicit rule.
      expect(short.responses[2]!.cacheEvent).toBeUndefined();
      const long = session(Array.from({ length: 200 }, (_, i) => ({ input: i === 0 ? 30_000 : 4_500, read: i === 0 ? 0 : 27_000 + i, write: i === 100 ? 10 : 0, model: m })));
      markCacheEvents(long);
      expect(long.responses.filter((r) => r.cacheEvent)).toHaveLength(0);
    });

    it("treats a non-Claude model that writes on nearly every call as explicit once there are enough calls to tell", () => {
      const m = "gpt-5.6-terra";
      const calls = [{ input: 0, write: 30_000, model: m }, { input: 0, read: 30_000, write: 500, model: m }, { input: 0, read: 30_500, write: 500, model: m }, { input: 0, read: 26_500, write: 4_500, model: m }];
      const s = session(calls);
      markCacheEvents(s);
      expect(s.responses[3]!.cacheEvent).toMatchObject({ kind: "miss", recached: 4_500 });
      // With only 3 calls the same loss is not evidence of an explicit cache.
      const three = session(calls.slice(0, 2).concat({ input: 0, read: 26_500, write: 4_500, model: m }));
      markCacheEvents(three);
      expect(three.responses[2]!.cacheEvent).toBeUndefined();
    });
  });

  describe("expected events", () => {
    it("labels the first call after a compaction a rebuild, not a miss", () => {
      const s = session([{ write: 200_000 }, { read: 199_000, write: 1_000 }, { input: 5, read: 4_000, write: 21_000, before: [compaction] }, { read: 25_000, write: 400 }]);
      const summary = markCacheEvents(s);
      expect(s.responses[2]!.cacheEvent).toMatchObject({ kind: "rebuild", recached: 21_005 });
      expect(s.responses[3]!.cacheEvent).toBeUndefined();
      expect(summary).toMatchObject({ misses: 0, rebuilds: 1 });
      expect(summary?.extraCost).toBeUndefined();
    });

    it("pins how a compaction is matched to the next call: two compaction signals make one rebuild, and a call with no step is never one", () => {
      // Claude Code writes both a boundary and a summary entry for one compaction.
      const doubled = session([{ write: 200_000 }, { input: 5, read: 4_000, write: 21_000, before: [compaction, { ...compaction, id: "c2", text: "Compaction summary" }] }, { read: 25_000, write: 400 }]);
      const summary = markCacheEvents(doubled);
      expect(events(doubled).map((e) => e?.kind)).toEqual([undefined, "rebuild", undefined]);
      expect(summary).toMatchObject({ rebuilds: 1, misses: 0 });
      // A call the transcript shows no step for cannot be placed after a compaction, so it is judged on its numbers
      // alone (a miss), and the compaction is credited to the next call that has a step. Pinned so the comparison
      // does not quietly change: such calls are rare (an assistant message always has a block).
      const stepless = session([{ write: 200_000 }, { input: 5, read: 4_000, write: 21_000, before: [compaction], noStep: true }, { input: 5, read: 4_000, write: 21_000 }]);
      markCacheEvents(stepless);
      expect(stepless.responses[1]!.cacheEvent?.kind).toBe("miss");
      expect(stepless.responses[2]!.cacheEvent?.kind).toBe("rebuild");
      // Without a compaction anywhere, a step-less call is just a call.
      const plain = session([{ write: 200_000 }, { read: 200_000, write: 10, noStep: true }, { read: 200_010, write: 10 }]);
      markCacheEvents(plain);
      expect(events(plain)).toEqual([undefined, undefined, undefined]);
    });

    it("does not flag a compaction that the next call handled from cache", () => {
      const s = session([{ write: 200_000 }, { read: 24_000, write: 500, before: [compaction] }]);
      markCacheEvents(s);
      expect(events(s)).toEqual([undefined, undefined]);
    });

    it("labels the first call on another model a model-switch, even under the implicit-cache threshold", () => {
      const s = session([
        { input: 10_800, model: "z-ai/glm-5.3-flash" },
        { input: 10_800, read: 10_000, model: "z-ai/glm-5.3-flash" },
        { input: 20_000, read: 6_656, model: "gpt-5.6-luna" },
        { input: 1_000, read: 25_000, model: "gpt-5.6-luna" },
      ]);
      const summary = markCacheEvents(s);
      expect(s.responses[2]!.cacheEvent).toMatchObject({ kind: "model-switch" });
      expect(events(s).filter(Boolean)).toHaveLength(1);
      expect(summary).toMatchObject({ misses: 0, modelSwitches: 1 });
    });

    it("compares a call only with the previous call of the same model, so a model that was used before does not hide a switch", () => {
      // A call on model B right after model A must be a switch even if B's prompt is mostly cached elsewhere.
      const s = session([{ write: 50_000 }, { read: 100, write: 50_000, model: "claude-haiku-4-5" }]);
      markCacheEvents(s);
      expect(s.responses[1]!.cacheEvent?.kind).toBe("model-switch");
    });
  });

  describe("calls that are not evidence", () => {
    it("skips calls the harness made itself, and does not use them as the previous prompt", () => {
      const s = session([{ write: 50_000 }, { input: 200_000, purpose: "compaction" }, { read: 50_000, write: 200 }]);
      const summary = markCacheEvents(s);
      expect(events(s)).toEqual([undefined, undefined, undefined]);
      expect(summary?.requests).toBe(2);
    });

    it("does not flag the first call after a call with no usage", () => {
      const s = session([{ write: 50_000 }, { input: 0, output: 0 }, { input: 50_000 }]);
      markCacheEvents(s);
      expect(events(s)).toEqual([undefined, undefined, undefined]);
    });

    it("does not flag inherited history or the first own call after it (a fork's cache belongs to the parent)", () => {
      const s = session([{ write: 50_000, inherited: true }, { input: 60_000, inherited: true }, { input: 62_000 }, { input: 1_000, read: 61_500 }]);
      const summary = markCacheEvents(s);
      expect(events(s)).toEqual([undefined, undefined, undefined, undefined]);
      expect(summary?.requests).toBe(2);
    });

    it("shows nothing for a provider that reports no cache tokens at all", () => {
      const s = session([{ input: 50_000 }, { input: 55_000 }, { input: 60_000 }]);
      expect(markCacheEvents(s)).toBeUndefined();
      expect(events(s)).toEqual([undefined, undefined, undefined]);
    });

    it("checks each model separately: a model that reports no caching is skipped while another is measured", () => {
      const s = session([
        { write: 50_000 },
        { read: 50_010, write: 100 },
        { input: 60_000, model: "no-cache-local" },
        { input: 65_000, model: "no-cache-local" },
      ]);
      const summary = markCacheEvents(s);
      expect(events(s)).toEqual([undefined, undefined, undefined, undefined]);
      expect(summary?.requests).toBe(2);
    });

    it("clears events left over from an earlier run", () => {
      const s = session([{ write: 50_000 }, { input: 50_000 }]);
      markCacheEvents(s);
      expect(s.responses[1]!.cacheEvent?.kind).toBe("miss");
      s.responses[1]!.usage = { input: 10, output: 5, cacheRead: 50_000, cacheWrite: 0, reasoning: 0 };
      markCacheEvents(s);
      expect(s.responses[1]!.cacheEvent).toBeUndefined();
    });
  });

  describe("idle gap", () => {
    it("records the gap and calls it idle when it outlasts a 1-hour cache", () => {
      const s = session([{ write: 90_000, write1h: 90_000, min: 0 }, { read: 24_000, write: 66_000, write1h: 66_000, min: 271 }]);
      markCacheEvents(s);
      expect(s.responses[1]!.cacheEvent).toMatchObject({ kind: "miss", gapMs: 271 * 60_000, idle: true });
    });

    it("keeps the gap but does not call it idle when it is shorter than the cache lifetime", () => {
      const s = session([{ write: 90_000, write1h: 90_000, min: 0 }, { read: 24_000, write: 66_000, write1h: 66_000, min: 20 }]);
      markCacheEvents(s);
      const e = s.responses[1]!.cacheEvent!;
      expect(e.gapMs).toBe(20 * 60_000);
      expect(e.idle).toBeUndefined();
    });

    it("uses 5 minutes as the lifetime for Claude Code writes with no 1-hour breakdown (Anthropic's default)", () => {
      const s = session([{ write: 90_000, min: 0 }, { read: 24_000, write: 66_000, min: 26 }], {}, "claude-code");
      markCacheEvents(s);
      expect(s.responses[1]!.cacheEvent).toMatchObject({ gapMs: 26 * 60_000, idle: true });
    });

    it("does not call a gap under an hour idle when nothing records the cache lifetime (any other agent)", () => {
      // pi with an explicit cache and no 1-hour writes: 5 minutes is a guess, so the gap is shown but not called idle.
      const explicit = session([{ write: 90_000, min: 0 }, { read: 24_000, write: 66_000, min: 44 }, { read: 90_000, write: 10, min: 45 }, { read: 24_000, write: 66_010, min: 140 }], {}, "pi");
      markCacheEvents(explicit);
      expect(explicit.responses[1]!.cacheEvent).toMatchObject({ kind: "miss", gapMs: 44 * 60_000 });
      expect(explicit.responses[1]!.cacheEvent!.idle).toBeUndefined();
      // A gap longer than any cache lives is still explained.
      expect(explicit.responses[3]!.cacheEvent).toMatchObject({ gapMs: 95 * 60_000, idle: true });
      // The same for a model that reports writes on every call but is not an Anthropic model.
      const m = "gpt-5.6-terra";
      const odd = session([{ write: 90_000, model: m, min: 0 }, { read: 24_000, write: 66_000, model: m, min: 44 }, { read: 90_000, write: 10, model: m, min: 45 }, { read: 90_000, write: 10, model: m, min: 46 }], {}, "pi");
      markCacheEvents(odd);
      expect(odd.responses[1]!.cacheEvent).toMatchObject({ kind: "miss", gapMs: 44 * 60_000 });
      expect(odd.responses[1]!.cacheEvent!.idle).toBeUndefined();
    });

    it("keeps the 1-hour lifetime evidenced by 1-hour writes, in any agent", () => {
      const s = session([{ write: 90_000, write1h: 90_000, min: 0 }, { read: 24_000, write: 66_000, write1h: 66_000, min: 44 }, { read: 90_000, write: 10, write1h: 10, min: 45 }, { read: 24_000, write: 66_010, write1h: 66_010, min: 140 }], {}, "pi");
      markCacheEvents(s);
      expect(s.responses[1]!.cacheEvent!.idle).toBeUndefined();
      expect(s.responses[3]!.cacheEvent!.idle).toBe(true);
    });

    it("gives no gap without timestamps, and still flags the miss", () => {
      const s = session([{ write: 90_000 }, { read: 24_000, write: 66_000 }]);
      markCacheEvents(s);
      const e = s.responses[1]!.cacheEvent!;
      expect(e.kind).toBe("miss");
      expect(e.gapMs).toBeUndefined();
      expect(e.idle).toBeUndefined();
    });

    it("is not the trigger: a long gap that stayed cached is not flagged", () => {
      const s = session([{ write: 90_000, min: 0 }, { read: 90_010, write: 200, min: 100 }]);
      markCacheEvents(s);
      expect(s.responses[1]!.cacheEvent).toBeUndefined();
    });

    it("measures the gap from the latest call of any kind, so a keep-alive resets the clock", () => {
      const s = session([{ write: 90_000, write1h: 90_000, min: 0 }, { input: 10, read: 90_000, purpose: "cache-warm", min: 50 }, { read: 24_000, write: 66_000, write1h: 66_000, min: 130 }]);
      markCacheEvents(s);
      expect(s.responses[2]!.cacheEvent).toMatchObject({ gapMs: 80 * 60_000, idle: true });
    });

    it("never calls a rebuild or model switch idle (they are expected anyway)", () => {
      const s = session([{ write: 90_000, write1h: 90_000, min: 0 }, { input: 5, read: 4_000, write: 21_000, write1h: 21_000, min: 500, before: [compaction] }]);
      markCacheEvents(s);
      expect(s.responses[1]!.cacheEvent).toMatchObject({ kind: "rebuild", gapMs: 500 * 60_000 });
      expect(s.responses[1]!.cacheEvent!.idle).toBeUndefined();
    });
  });

  describe("extra cost", () => {
    // Opus 5.5 list prices: $4 in, $0.20 read, $5 5-minute write, $8 1-hour write per million.
    const price = (u: Partial<Usage>) => estimateCost(OPUS, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, ...u })!;

    it("prices re-processed tokens at the 1-hour write rate over the read rate", () => {
      const s = session([{ write: 400_000, write1h: 400_000 }, { input: 5, read: 24_000, write: 376_000, write1h: 376_000 }]);
      const summary = markCacheEvents(s);
      const e = s.responses[1]!.cacheEvent!;
      expect(e.recached).toBe(400_005 - 24_000);
      // 376,000 written at $8 and 5 uncached at $4, instead of all 376,005 read at $0.20.
      expect(e.cost).toBeCloseTo(price({ cacheWrite: 376_000, cacheWrite1h: 376_000, input: 5 }) - price({ cacheRead: 376_005 }), 6);
      expect(e.cost).toBeCloseTo(2.93, 1);
      expect(summary?.extraCost).toBeCloseTo(e.cost!, 12);
    });

    it("prices 5-minute writes lower than 1-hour writes", () => {
      const short = session([{ write: 400_000 }, { input: 5, read: 24_000, write: 376_000 }]);
      const long = session([{ write: 400_000, write1h: 400_000 }, { input: 5, read: 24_000, write: 376_000, write1h: 376_000 }]);
      markCacheEvents(short);
      markCacheEvents(long);
      // (5.00 - 0.20) versus (8.00 - 0.20) per million re-processed.
      expect(short.responses[1]!.cacheEvent!.cost).toBeCloseTo((376_000 * 4.8 + 5 * 3.8) / 1e6, 6);
      expect(long.responses[1]!.cacheEvent!.cost).toBeGreaterThan(short.responses[1]!.cacheEvent!.cost! * 1.5);
    });

    it("splits the cost across a call's 5-minute and 1-hour writes in proportion", () => {
      const s = session([{ write: 100_000 }, { input: 0, read: 20_000, write: 80_000, write1h: 40_000 }]);
      markCacheEvents(s);
      // Re-processed 80,000 tokens: half at $5, half at $8, against $0.20 for a read.
      expect(s.responses[1]!.cacheEvent!.cost).toBeCloseTo((40_000 * 4.8 + 40_000 * 7.8) / 1e6, 6);
    });

    it("leaves the cost out for a model with no known price rather than showing $0", () => {
      const s = session([{ write: 90_000, model: "claude-unreleased-9" }, { read: 20_000, write: 70_000, model: "claude-unreleased-9" }]);
      const summary = markCacheEvents(s);
      expect(s.responses[1]!.cacheEvent).toMatchObject({ kind: "miss" });
      expect(s.responses[1]!.cacheEvent!.cost).toBeUndefined();
      expect(summary?.misses).toBe(1);
      expect(summary?.extraCost).toBeUndefined();
    });

    it("uses the rates a harness recorded (input minus cache read for providers with no write price)", () => {
      const model = "gpt-5.6-terra";
      const s = session(
        [
          { input: 500, read: 99_500, model },
          { input: 100_000, read: 0, model },
        ],
        { rates: { [model]: { input: 2.5, cacheRead: 0.25 } } },
      );
      const summary = markCacheEvents(s);
      expect(s.responses[1]!.cacheEvent!.cost).toBeCloseTo((100_000 * (2.5 - 0.25)) / 1e6, 9);
      expect(summary?.extraCost).toBeCloseTo(0.225, 9);
    });

    it("shows no dollars for a call the harness recorded as free, even for a model the price table knows", () => {
      const s = session([{ write: 90_000, cost: 0 }, { read: 20_000, write: 70_000, cost: 0 }]);
      const summary = markCacheEvents(s);
      expect(s.responses[1]!.cacheEvent).toMatchObject({ kind: "miss" });
      expect(s.responses[1]!.cacheEvent!.cost).toBeUndefined();
      expect(summary?.extraCost).toBeUndefined();
      // A priced call of the same model still gets its cost.
      const paid = session([{ write: 90_000, cost: 1 }, { read: 20_000, write: 70_000, cost: 1 }]);
      markCacheEvents(paid);
      expect(paid.responses[1]!.cacheEvent!.cost).toBeGreaterThan(0);
    });

    it("counts only unexpected misses in the summary's extra cost, and marks it partial when some were unpriced", () => {
      const s = session([
        { write: 100_000 },
        { input: 0, read: 10_000, write: 90_000 },
        { input: 0, read: 100_000, write: 10 },
        { input: 0, read: 800, write: 30_000, model: "claude-unreleased-9" },
        { input: 5, read: 4_000, write: 21_000, model: "claude-unreleased-9", before: [compaction] },
        { input: 0, read: 100, write: 25_000, model: "claude-unreleased-9" },
      ]);
      const summary = markCacheEvents(s);
      // The switch and the rebuild are expected (no cost counted); the unpriced second miss makes the total a lower bound.
      expect(summary).toMatchObject({ misses: 2, modelSwitches: 1, rebuilds: 1, extraCostPartial: true });
      expect(summary?.extraCost).toBeCloseTo(s.responses[1]!.cacheEvent!.cost!, 12);
    });
  });

  it("summarizes the share of prompt tokens read from cache over the calls that report caching", () => {
    const s = session([{ input: 10, write: 990 }, { input: 10, read: 990, write: 10 }]);
    // (0 + 990) of (1000 + 1010) tokens.
    expect(markCacheEvents(s)?.cachedPct).toBe(49);
  });
});

describe("cache events through the adapters and the pipeline", () => {
  it("flags the call after a Claude Code compaction as a rebuild", () => {
    const t = new ClaudeTranscript()
      .user("go")
      .assistant("m1", [{ type: "text", text: "a" }], ccUsage(5, 40, 200_000, 500), OPUS)
      .assistant("m2", [{ type: "text", text: "b" }], ccUsage(5, 40, 200_500, 500), OPUS)
      .system("compact_boundary", { compactMetadata: { trigger: "auto", preTokens: 201_000 } })
      .user("summary", { isCompactSummary: true })
      .user("continue")
      .assistant("m3", [{ type: "text", text: "c" }], ccUsage(5, 40, 4_000, 21_000), OPUS)
      .assistant("m4", [{ type: "text", text: "d" }], ccUsage(5, 40, 25_000, 600), OPUS);
    const { session: s } = parseClaudeCode(t.toJsonl());
    const st = computeStats(s);
    expect(s.responses.map((r) => r.cacheEvent?.kind)).toEqual([undefined, undefined, "rebuild", undefined]);
    expect(st.cache).toMatchObject({ requests: 4, misses: 0, rebuilds: 1 });
  });

  it("flags a Claude Code miss with the extra cost of 1-hour writes", () => {
    const write = { ...ccUsage(5, 40, 24_000, 376_000), cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 376_000 } };
    const t = new ClaudeTranscript().user("go").assistant("m1", [{ type: "text", text: "a" }], ccUsage(5, 40, 0, 400_000), OPUS).user("later").assistant("m2", [{ type: "text", text: "b" }], write, OPUS);
    const { session: s } = parseClaudeCode(t.toJsonl());
    const st = computeStats(s);
    expect(s.responses[1]!.cacheEvent).toMatchObject({ kind: "miss", recached: 376_005 });
    expect(s.responses[1]!.cacheEvent!.cost).toBeGreaterThan(2.5);
    expect(st.cache).toMatchObject({ misses: 1 });
  });

  it("prices a pi miss from the rates in the recorded cost breakdown", () => {
    const cost = (input: number, cacheRead: number) => ({ input: (input * 2.5) / 1e6, cacheRead: (cacheRead * 0.25) / 1e6, cacheWrite: 0, output: 0, total: (input * 2.5 + cacheRead * 0.25) / 1e6 });
    const usage = (input: number, cacheRead: number) => ({ ...piUsage(input, 20, cacheRead, 0), cost: cost(input, cacheRead) });
    const t = new PiTranscript().user("go");
    t.assistant([{ type: "text", text: "a" }], usage(500, 60_000), { model: "gpt-x" });
    t.assistant([{ type: "text", text: "b" }], usage(60_500, 0), { model: "gpt-x" });
    const { session: s } = parsePi(t.toJsonl());
    const st = computeStats(s);
    expect(st.rates?.["gpt-x"]).toEqual({ input: 2.5, cacheRead: 0.25 });
    expect(s.responses[1]!.cacheEvent).toMatchObject({ kind: "miss", recached: 60_500 });
    expect(s.responses[1]!.cacheEvent!.cost).toBeCloseTo((60_500 * 2.25) / 1e6, 9);
  });

  it("shows no cache summary for a pi provider that reports no cache tokens", () => {
    const t = new PiTranscript().user("go");
    t.assistant([{ type: "text", text: "a" }], piUsage(50_000, 20));
    t.assistant([{ type: "text", text: "b" }], piUsage(60_000, 20));
    const { session: s } = parsePi(t.toJsonl());
    expect(computeStats(s).cache).toBeUndefined();
  });

  it("keeps the same events and summary in every share mode (computed before projection)", () => {
    const t = new ClaudeTranscript().user("go").assistant("m1", [{ type: "text", text: "a" }], ccUsage(5, 40, 0, 400_000), OPUS).user("later").assistant("m2", [{ type: "text", text: "b" }], ccUsage(5, 40, 24_000, 376_000), OPUS);
    const shares = SHARE_MODES.map((mode) => prepareShare(t.toJsonl(), { mode, config: DEFAULT_CONFIG, harness: "claude-code", knownSecrets: [] }).session);
    for (const s of shares) {
      expect(s.stats.cache).toEqual(shares[0]!.stats.cache);
      expect(s.responses.map((r) => r.cacheEvent)).toEqual(shares[0]!.responses.map((r) => r.cacheEvent));
    }
    expect(shares[0]!.stats.cache).toMatchObject({ misses: 1 });
    expect(shares[0]!.responses[1]!.cacheEvent?.kind).toBe("miss");
  });

  it("leaves a session with no cache activity without the summary", () => {
    const t = new ClaudeTranscript().user("go").assistant("m1", [{ type: "text", text: "a" }], ccUsage(500, 40), OPUS);
    expect(computeStats(parseClaudeCode(t.toJsonl()).session).cache).toBeUndefined();
  });
});
