/**
 * Local audit of the usage numbers against the sessions on this machine (not run in CI:
 * it needs your own Claude Code / pi history).
 *
 *   npm run audit:usage
 *
 * - Claude Code: our estimated cost versus Claude Code's own `cost-state` total, for the
 *   sessions where that total covers the whole transcript (not resumed). The estimate
 *   should sit a little below it (calls the transcript never shows: compaction, Haiku
 *   background work, subagents) and never above. The worst sessions are listed, and models
 *   without a price are reported.
 * - pi: per session, the tokens our adapter reports (own + other branches + inherited)
 *   against the raw sum over every usage-bearing entry in the file. They must agree, except
 *   that a fork's file may hold parent-branch entries we deliberately skip. Separately, the
 *   provider's own `totalTokens` is checked against its parts (a check on the data itself).
 * - Cache misses: how many calls each harness flags (by kind and model), how many a uniform
 *   Claude-Code rule (5% and 2,000 tokens) would flag instead, and the ten largest by extra
 *   cost to spot-check. Session ids are the first 8 characters; no transcript text is printed.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { parseClaudeCode } from "../src/adapters/claude-code.ts";
import { parsePi } from "../src/adapters/pi.ts";
import { formatCost, formatDuration, formatTokens } from "../src/format.ts";
import { defaultRoots } from "../src/resolve.ts";
import { contextTokens, totalTokens, type NormalizedSession } from "../src/schema.ts";
import { computeStats } from "../src/stats.ts";

const roots = defaultRoots();

/** Flagged calls per harness, and the largest ten by extra cost. */
interface Flag {
  harness: string;
  session: string;
  turn: number;
  model: string;
  kind: string;
  gapMs?: number;
  idle: boolean;
  recached: number;
  context: number;
  cacheRead: number;
  cost?: number;
}
const flags: Flag[] = [];
const totals: Record<string, { sessions: number; calls: number; flagged: number; uniform: number; kinds: Record<string, number>; models: Record<string, [calls: number, flagged: number]> }> = {};

/** What the plain Claude Code rule (5% and 2,000 tokens, any provider) would flag, for comparison. */
function uniformFlags(session: NormalizedSession): number {
  let n = 0;
  let prev: NormalizedSession["responses"][number] | undefined;
  for (const r of session.responses) {
    if (r.purpose || r.inherited || totalTokens(r.usage) === 0) continue;
    if (prev && prev.model === r.model) {
      const readable = Math.min(contextTokens(prev.usage), contextTokens(r.usage));
      const recached = Math.max(0, readable - r.usage.cacheRead);
      if (recached >= 2_000 && recached > readable * 0.05 && r.usage.cacheRead + r.usage.cacheWrite + prev.usage.cacheRead > 0) n += 1;
    }
    prev = r;
  }
  return n;
}

function auditCache(harness: string, id: string, session: NormalizedSession): void {
  const t = (totals[harness] ??= { sessions: 0, calls: 0, flagged: 0, uniform: 0, kinds: {}, models: {} });
  t.sessions += 1;
  t.uniform += uniformFlags(session);
  for (const r of session.responses) {
    if (r.purpose || r.inherited) continue;
    const m = (t.models[r.model ?? "?"] ??= [0, 0]);
    t.calls += 1;
    m[0] += 1;
    const e = r.cacheEvent;
    if (!e) continue;
    t.flagged += 1;
    m[1] += 1;
    t.kinds[e.kind] = (t.kinds[e.kind] ?? 0) + 1;
    flags.push({ harness, session: id, turn: r.turn, model: r.model ?? "?", kind: e.kind, ...(e.gapMs !== undefined ? { gapMs: e.gapMs } : {}), idle: Boolean(e.idle), recached: e.recached, context: contextTokens(r.usage), cacheRead: r.usage.cacheRead, ...(e.cost !== undefined ? { cost: e.cost } : {}) });
  }
}

function reportCache(): void {
  console.log("\nCache misses (calls of the conversation; calls the agent made itself are skipped)");
  for (const [h, t] of Object.entries(totals)) {
    const models = Object.entries(t.models)
      .filter(([, [, f]]) => f > 0)
      .sort((a, b) => b[1][1] - a[1][1])
      .map(([m, [c, f]]) => `${m.split("/").pop()} ${f}/${c}`)
      .join(", ");
    console.log(`  ${h}: ${t.sessions} sessions, ${t.calls} calls -> ${t.flagged} flagged ${JSON.stringify(t.kinds)}; a uniform 5%/2,000-token rule would flag ${t.uniform}`);
    console.log(`    flagged/calls by model: ${models || "none"}`);
    const spent = flags.filter((f) => f.harness === h && f.kind === "miss");
    console.log(`    misses with a known idle explanation: ${spent.filter((f) => f.idle).length} of ${spent.length}; total extra cost of misses ${formatCost(spent.reduce((n, f) => n + (f.cost ?? 0), 0))}`);
  }
  for (const h of Object.keys(totals)) {
    console.log(`  top 10 ${h} by extra cost:`);
    const top = flags.filter((f) => f.harness === h).sort((a, b) => (b.cost ?? -1) - (a.cost ?? -1)).slice(0, 10);
    for (const f of top) {
      const gap = f.gapMs === undefined ? "no gap" : `gap ${formatDuration(f.gapMs)}${f.idle ? " (idle)" : ""}`;
      console.log(`    ${f.session} turn ${f.turn} ${f.kind.padEnd(12)} ${f.model.split("/").pop()} ${formatTokens(f.recached)} re-cached of ${formatTokens(f.context)} (read ${formatTokens(f.cacheRead)}) ${gap} ${f.cost !== undefined ? formatCost(f.cost) : "unpriced"}`);
    }
  }
}

function* jsonl(root: string): Generator<string> {
  let dirs: string[];
  try {
    dirs = readdirSync(root);
  } catch {
    return;
  }
  for (const d of dirs) {
    const dir = join(root, d);
    if (!statSync(dir).isDirectory()) continue;
    for (const f of readdirSync(dir)) if (f.endsWith(".jsonl")) yield join(dir, f);
  }
}

const errors: { id: string; error: number; ours: number; theirs: number }[] = [];
const unpriced = new Map<string, number>();
let claude = 0;
let resumed = 0;
for (const file of jsonl(roots["claude-code"])) {
  const raw = readFileSync(file, "utf8");
  const { session } = parseClaudeCode(raw);
  claude += 1;
  for (const r of session.responses) if (r.usage.cost === undefined && r.model && r.model !== "<synthetic>") unpriced.set(r.model, (unpriced.get(r.model) ?? 0) + 1);
  const state = raw
    .split("\n")
    .filter((l) => l.startsWith('{"type":"cost-state"'))
    .map((l) => JSON.parse(l) as { totalCostUSD: number; startTime: number })
    .at(-1);
  const stats = computeStats(session);
  auditCache("claude", basename(file, ".jsonl").slice(0, 8), session);
  if (!state || stats.cost === undefined || state.totalCostUSD < 0.05) continue;
  const first = Date.parse(session.startedAt ?? "");
  if (state.startTime - first > 120_000) {
    resumed += 1;
    continue;
  }
  errors.push({ id: basename(file, ".jsonl").slice(0, 8), error: (stats.cost - state.totalCostUSD) / state.totalCostUSD, ours: stats.cost, theirs: state.totalCostUSD });
}
errors.sort((a, b) => a.error - b.error);
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
console.log(`Claude Code: ${claude} sessions; ${errors.length} comparable to cost-state (${resumed} resumed sessions skipped)`);
if (errors.length) {
  console.log(`  estimate vs cost-state: median ${pct(errors[Math.floor(errors.length / 2)]!.error)}, min ${pct(errors[0]!.error)}, max ${pct(errors.at(-1)!.error)} (max should be <= 0)`);
  console.log("  furthest below cost-state:");
  for (const e of errors.slice(0, 5)) console.log(`    ${e.id}  ours $${e.ours.toFixed(2)} vs $${e.theirs.toFixed(2)} (${pct(e.error)})`);
  const above = errors.filter((e) => e.error > 0.005);
  if (above.length) console.log(`  ABOVE cost-state (price table too high?): ${above.map((e) => `${e.id} ${pct(e.error)}`).join(", ")}`);
}
for (const [m, n] of unpriced) console.log(`  no price for ${m} (${n} calls): run scripts/update-prices.mjs or extend src/pricing.ts`);

type Raw = { type?: string; message?: { role?: string; usage?: Record<string, number> }; usage?: Record<string, number>; parentSession?: string };
const rawTokens = (u: Record<string, number> | undefined): number => {
  if (!u) return 0;
  const parts = (u.input ?? 0) + (u.output ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
  // The adapter falls back to the provider's total when nothing was reported as output.
  return (u.output ?? 0) === 0 ? Math.max(parts, u.totalTokens ?? 0) : parts;
};
let sessions = 0;
let forkGaps = 0;
let provider = 0;
let providerOff = 0;
const bad: string[] = [];
for (const file of jsonl(roots.pi)) {
  const text = readFileSync(file, "utf8");
  let raw = 0;
  let isFork = false;
  for (const line of text.split("\n")) {
    if (!line.includes('"usage"') && !line.includes("parentSession")) continue;
    let e: Raw;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.parentSession) isFork = true;
    const u = e.type === "message" ? (e.message?.role === "assistant" || e.message?.role === "toolResult" ? e.message.usage : undefined) : e.usage;
    raw += rawTokens(u);
    if (e.type === "message" && e.message?.role === "assistant" && u?.totalTokens !== undefined) {
      provider += 1;
      if ((u.input ?? 0) + (u.output ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0) !== u.totalTokens) providerOff += 1;
    }
  }
  const parsed = parsePi(text).session;
  const st = computeStats(parsed);
  auditCache("pi", basename(file, ".jsonl").split("_").pop()!.slice(0, 8), parsed);
  const ours = totalTokens(st.tokens) + (st.otherBranches ? totalTokens(st.otherBranches.tokens) : 0) + (st.inherited ? totalTokens(st.inherited.tokens) : 0);
  sessions += 1;
  if (ours === raw) continue;
  if (isFork && ours < raw) forkGaps += 1; // parent-branch entries a fork file carries are skipped on purpose
  else bad.push(`${basename(file).slice(-16, -6)} ours ${ours} vs raw ${raw}`);
}
console.log(`pi: ${sessions} sessions; adapter totals match the raw file in ${sessions - forkGaps - bad.length} (${forkGaps} forks skip parent-branch entries on purpose)${bad.length ? `; ${bad.length} DIFFER:` : ""}`);
for (const b of bad.slice(0, 10)) console.log(`    ${b}`);
console.log(`pi provider data: ${provider} calls, ${providerOff} where input+output+cache differs from the provider's totalTokens`);

reportCache();
