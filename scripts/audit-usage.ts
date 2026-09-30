/**
 * Local audit of the usage numbers against the sessions on this machine (not run in CI:
 * it needs your own Claude Code / pi history).
 *
 *   npm run audit:usage
 *
 * - Claude Code: our estimated cost versus Claude Code's own `cost-state` total, for the
 *   sessions where that total covers the whole transcript (not resumed). The estimate
 *   should sit a little below it (calls the transcript never shows: compaction, Haiku
 *   background work, subagents) and never above. Models without a price are listed.
 * - pi: our token sum versus each call's provider-reported `totalTokens`.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseClaudeCode } from "../src/adapters/claude-code.ts";
import { parsePi } from "../src/adapters/pi.ts";
import { defaultRoots } from "../src/resolve.ts";
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

const errors: number[] = [];
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
  errors.push((stats.cost - state.totalCostUSD) / state.totalCostUSD);
}
errors.sort((a, b) => a - b);
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
console.log(`Claude Code: ${claude} sessions; ${errors.length} comparable to cost-state (${resumed} resumed sessions skipped)`);
if (errors.length) console.log(`  estimate vs cost-state: median ${pct(errors[Math.floor(errors.length / 2)]!)}, min ${pct(errors[0]!)}, max ${pct(errors.at(-1)!)} (max should be <= 0)`);
for (const [m, n] of unpriced) console.log(`  no price for ${m} (${n} calls): run scripts/update-prices.mjs or extend src/pricing.ts`);

let calls = 0;
let mismatched = 0;
for (const file of jsonl(roots.pi)) {
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.includes('"totalTokens"')) continue;
    let e: { type?: string; message?: { role?: string; usage?: Record<string, number> } };
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    const u = e.message?.usage;
    if (e.type !== "message" || e.message?.role !== "assistant" || !u || u.totalTokens === undefined) continue;
    calls += 1;
    if ((u.input ?? 0) + (u.output ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0) !== u.totalTokens) mismatched += 1;
  }
  parsePi(readFileSync(file, "utf8"));
}
console.log(`pi: ${calls} calls checked, ${mismatched} where our token sum differs from the provider's totalTokens`);
