/**
 * Prompt cache misses, detected from token counts (browser-safe, no Node imports).
 *
 * Claude Code's own `/usage` defines a miss as a request that re-processed more than 5% and at
 * least 2,000 tokens of what it could have read from cache. We apply the same rule to every
 * harness: the prefix a call could have read is what the previous call's prompt held (capped at
 * this call's prompt), and `cacheRead` says how much of it was actually read. Wall-clock idle
 * time is never the trigger, only the explanation: a 100-minute gap can stay fully cached when
 * keep-alive calls the transcript does not show refreshed the entry.
 *
 * Two kinds of flagged call are expected and reported apart from real misses: the first call
 * after a compaction (`rebuild`) and the first call on another model (`model-switch`; the cache
 * is per model).
 */
import { cacheWrite1hRate, findPrice } from "./pricing.js";
import { contextTokens, totalTokens, type CacheEvent, type CacheSummary, type NormalizedSession, type ResponseUsage, type TokenRates, type Usage } from "./schema.js";

/**
 * How much of the prefix a call could have read it must have re-processed to count as a miss
 * (more than `fraction` of it, and at least `tokens`).
 *
 * `explicit` is Claude Code's own rule, for providers that report cache writes (Anthropic): caching
 * is deterministic, so a small loss is a real one. It also applies to the expected kinds (`rebuild`,
 * `model-switch`) on every provider. `implicit`, for unexplained misses only, is for providers that never report
 * writes (OpenAI, xAI, GLM, DeepSeek, ...): their caching is best-effort and reads come in coarse
 * blocks (128 to 2,304 tokens in the local data), so an ordinary call lags the prefix by a block or two
 * and would be flagged under the explicit rule (978 of 14,791 calls in one pi corpus, mostly
 * GLM). Real losses there drop nearly the whole prefix, so require most of it and a size worth noting.
 */
export const MISS_RULE = {
  explicit: { fraction: 0.05, tokens: 2_000 },
  implicit: { fraction: 0.5, tokens: 10_000 },
} as const;

/** Calls of a model needed before the share of them that write says whether its cache is explicit. */
const EXPLICIT_MIN_CALLS = 4;
const HOUR_MS = 3_600_000;
const FIVE_MIN_MS = 300_000;

/** What the extra cost of `recached` tokens is estimated from: recorded rates when the harness has them, else the price table. */
function extraCost(model: string | undefined, u: Usage, recached: number, rates: Record<string, TokenRates> | undefined): number | undefined {
  const uncached = u.input + u.cacheWrite;
  // A call the harness recorded as free (a subscription or free tier) has no dollars to lose, whatever list price says.
  if (uncached <= 0 || u.cost === 0) return undefined;
  const recorded = model ? rates?.[model] : undefined;
  let input: number, read: number, write5: number, write1: number;
  if (recorded) {
    ({ input, cacheRead: read } = recorded);
    write5 = write1 = recorded.cacheWrite ?? recorded.input;
  } else {
    const p = findPrice(model);
    if (!p) return undefined;
    ({ input, cacheRead: read, cacheWrite: write5 } = p);
    write1 = cacheWrite1hRate(p);
  }
  const long = Math.min(u.cacheWrite1h ?? 0, u.cacheWrite);
  // The re-processed tokens were billed as this call's uncached input and cache writes, in their proportions.
  const paid = (u.input * input + (u.cacheWrite - long) * write5 + long * write1) / uncached;
  return Math.max(0, (recached * (paid - read)) / 1_000_000);
}

const timeOf = (r: ResponseUsage): number => (r.timestamp ? Date.parse(r.timestamp) : Number.NaN);

/**
 * Flag cache misses on `session.responses` (setting `cacheEvent` on each flagged call and clearing it
 * elsewhere) and summarize the session's own calls. Undefined when no call reports prompt caching.
 * Run on the full session, before any share-mode projection.
 *
 * The idle gap explains a miss only when it is longer than the cache can live, and we only claim what
 * the data supports: an hour when the model's writes are billed at the 1-hour rate, 5 minutes for
 * Claude Code writes with no 1-hour breakdown (Anthropic's default), and otherwise (any other agent
 * or provider, whose lifetime no transcript records) the hour that outlasts every cache we know of.
 * A shorter gap is still shown, just not called idle.
 *
 * Not events: the first call of a session, the first own call after a fork's inherited history, the
 * first call after a call with no usage, calls the harness made itself (`purpose`), and calls on a
 * model that never reports cache tokens (the provider does no caching, or hides it).
 */
export function markCacheEvents(session: Pick<NormalizedSession, "responses" | "turns"> & { harness?: Pick<NormalizedSession["harness"], "name">; stats?: Pick<NormalizedSession["stats"], "rates"> }): CacheSummary | undefined {
  // Which calls follow a compaction, from the order of steps in the transcript.
  const compactionsBefore = new Map<string, number>();
  let compactions = 0;
  for (const turn of session.turns) {
    for (const step of turn.steps) {
      if (step.kind === "event" && step.event === "compaction") compactions += 1;
      if (step.responseId && !compactionsBefore.has(step.responseId)) compactionsBefore.set(step.responseId, compactions);
    }
  }

  // What each model's usage says about its provider's caching.
  const claudeCode = session.harness?.name === "claude-code";
  const models = new Map<string, { calls: number; writes: number; reports: boolean; explicit: boolean; oneHour: boolean; ttl: number }>();
  for (const r of session.responses) {
    if (r.purpose) continue;
    const m = models.get(r.model ?? "") ?? { calls: 0, writes: 0, reports: false, explicit: false, oneHour: false, ttl: HOUR_MS };
    m.calls += 1;
    if (r.usage.cacheRead + r.usage.cacheWrite > 0) m.reports = true;
    if (r.usage.cacheWrite > 0) m.writes += 1;
    // Writes billed at the 1-hour rate mean the entry lives for an hour (Anthropic's default is 5 minutes).
    if ((r.usage.cacheWrite1h ?? 0) > 0) m.oneHour = true;
    models.set(r.model ?? "", m);
  }
  for (const [model, m] of models) {
    // Anthropic models cache explicitly by definition. For any other model go by what it reports: writes on
    // nearly every call, over enough calls to tell (a stray write on an implicit cache, 1% of one GPT
    // model's calls or 1 call in 3, does not make it explicit).
    m.explicit = (model !== "" && findPrice(model) !== undefined) || (m.calls >= EXPLICIT_MIN_CALLS && m.writes >= m.calls * 0.25);
    m.ttl = m.oneHour || !(claudeCode && m.explicit) ? HOUR_MS : FIVE_MIN_MS;
  }
  const rates = session.stats?.rates;

  const sum = { requests: 0, cacheRead: 0, context: 0, misses: 0, rebuilds: 0, modelSwitches: 0, recached: 0, cost: 0, priced: 0, unpriced: 0 };
  let prev: ResponseUsage | undefined;
  let prevCompactions = 0;
  let lastTime = Number.NaN;
  for (const r of session.responses) {
    delete r.cacheEvent;
    const time = timeOf(r);
    if (r.purpose) {
      // A keep-alive or compaction call still refreshes (or resets) the cache clock, but is not part of the conversation's prompt chain.
      if (Number.isFinite(time)) lastTime = time;
      continue;
    }
    const ctx = contextTokens(r.usage);
    if (totalTokens(r.usage) === 0) {
      prev = undefined;
      continue;
    }
    const seenCompactions = compactionsBefore.get(r.id) ?? prevCompactions;
    const profile = models.get(r.model ?? "");
    const counts = !r.inherited && Boolean(profile?.reports);
    if (counts) {
      sum.requests += 1;
      sum.cacheRead += r.usage.cacheRead;
      sum.context += ctx;
    }
    if (counts && prev && !prev.inherited) {
      const readable = Math.min(contextTokens(prev.usage), ctx);
      const recached = Math.max(0, readable - r.usage.cacheRead);
      const kind = (prev.model ?? "") !== (r.model ?? "") ? "model-switch" : seenCompactions > prevCompactions ? "rebuild" : "miss";
      // Only an unexplained miss needs the guard against best-effort caches' noise; the expected kinds are rare and always worth noting.
      const rule = kind === "miss" && !profile!.explicit ? MISS_RULE.implicit : MISS_RULE.explicit;
      if (recached >= rule.tokens && recached > readable * rule.fraction) {
        const gap = time - lastTime;
        const event: CacheEvent = { kind, recached };
        if (Number.isFinite(gap) && gap >= 0) {
          event.gapMs = gap;
          if (kind === "miss" && gap > profile!.ttl) event.idle = true;
        }
        const cost = extraCost(r.model, r.usage, recached, rates);
        if (cost !== undefined) event.cost = cost;
        r.cacheEvent = event;
        sum.recached += recached;
        if (kind === "miss") {
          sum.misses += 1;
          if (cost !== undefined) {
            sum.cost += cost;
            sum.priced += 1;
          } else sum.unpriced += 1;
        } else if (kind === "rebuild") sum.rebuilds += 1;
        else sum.modelSwitches += 1;
      }
    }
    prev = r;
    prevCompactions = seenCompactions;
    if (Number.isFinite(time)) lastTime = time;
  }
  if (sum.requests === 0) return undefined;
  return {
    requests: sum.requests,
    cachedPct: sum.context ? Math.round((sum.cacheRead / sum.context) * 100) : 0,
    misses: sum.misses,
    rebuilds: sum.rebuilds,
    modelSwitches: sum.modelSwitches,
    recached: sum.recached,
    ...(sum.priced > 0 ? { extraCost: sum.cost } : {}),
    ...(sum.priced > 0 && sum.unpriced > 0 ? { extraCostPartial: true as const } : {}),
  };
}
