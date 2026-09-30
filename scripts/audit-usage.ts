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
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { parseClaudeCode } from "../src/adapters/claude-code.ts";
import { parsePi } from "../src/adapters/pi.ts";
import { defaultRoots } from "../src/resolve.ts";
import { totalTokens } from "../src/schema.ts";
import { computeStats } from "../src/stats.ts";

const roots = defaultRoots();

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
  const st = computeStats(parsePi(text).session);
  const ours = totalTokens(st.tokens) + (st.otherBranches ? totalTokens(st.otherBranches.tokens) : 0) + (st.inherited ? totalTokens(st.inherited.tokens) : 0);
  sessions += 1;
  if (ours === raw) continue;
  if (isFork && ours < raw) forkGaps += 1; // parent-branch entries a fork file carries are skipped on purpose
  else bad.push(`${basename(file).slice(-16, -6)} ours ${ours} vs raw ${raw}`);
}
console.log(`pi: ${sessions} sessions; adapter totals match the raw file in ${sessions - forkGaps - bad.length} (${forkGaps} forks skip parent-branch entries on purpose)${bad.length ? `; ${bad.length} DIFFER:` : ""}`);
for (const b of bad.slice(0, 10)) console.log(`    ${b}`);
console.log(`pi provider data: ${provider} calls, ${providerOff} where input+output+cache differs from the provider's totalTokens`);
