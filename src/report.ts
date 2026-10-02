import { formatBytes, formatCacheSummary, formatSessionCost, formatTokens, formatUsageTotals, plural } from "./format.js";
import type { ShareReport } from "./pipeline.js";
import { SECRET_CATEGORIES, type RedactionCategory } from "./redact/index.js";
import { totalTokens } from "./schema.js";

/** Human-readable redaction report: rules, locations and counts, never secret values or the text around them. */
export function formatReport(r: ShareReport, opts: { maxFindings?: number; color?: boolean } = {}): string {
  const color = (code: number) => (s: string) => (opts.color ? `\x1b[${code}m${s}\x1b[0m` : s);
  const bold = color(1);
  const dim = color(2);
  const red = color(31);
  const green = color(32);
  const yellow = color(33);
  const lines: string[] = [];
  const s = r.stats;
  lines.push(bold(`agent-share report · ${r.harness} · ${r.sessionId.slice(0, 8)} · mode=${r.mode}`));
  if (r.title) lines.push(`  "${r.title}"`);
  const cost = formatSessionCost(s);
  const tokenLine = `${plural(s.responses, "model call")} · ${formatTokens(totalTokens(s.tokens))} tokens processed${cost ? ` · est. cost ${cost}` : ""}`;
  lines.push(
    dim(`  ${plural(s.turns, "turn")} · ${plural(s.toolCalls, "tool call")} · ${plural(s.subagents, "subagent")} · ${tokenLine} · ${formatBytes(r.bytes)} payload`),
  );
  const cacheLine = s.cache ? formatCacheSummary(s.cache) : "";
  if (cacheLine) lines.push(dim(`  prompt cache: ${s.cache!.cachedPct}% of prompt tokens read from cache · ${cacheLine}`));

  const sub = s.subagentUsage;
  if (sub?.agents) lines.push(dim(`  not counted: ${formatUsageTotals(sub)} by ${plural(sub.agents, "subagent")} (read from their transcripts)`));
  if (sub?.unlinked) lines.push(dim(`  not counted: ${formatUsageTotals(sub.unlinked)} by ${plural(sub.unlinked.agents, "subagent")} that no step on this branch launched`));
  if (s.otherBranches) lines.push(dim(`  not counted: ${formatUsageTotals(s.otherBranches)} on other branches`));
  if (s.inherited) lines.push(dim(`  not counted: ${formatUsageTotals(s.inherited)} inherited from the parent session`));

  const dropped = Object.entries(r.dropped).sort((a, b) => b[1] - a[1]);
  if (dropped.length) {
    lines.push("", bold("Dropped (never shared):"));
    lines.push(`  ${dropped.map(([k, n]) => `${k} ×${n}`).join(", ")}`);
  }

  lines.push("", bold("Redactions:"));
  const entries = Object.entries(r.counts) as [RedactionCategory, number][];
  if (entries.length === 0) lines.push("  none");
  for (const [category, n] of entries.sort((a, b) => b[1] - a[1])) {
    const secret = SECRET_CATEGORIES.has(category);
    lines.push(`  ${(secret ? yellow : dim)(`${category.padEnd(15)} ${String(n).padStart(5)}`)}${secret ? yellow("  ← review") : ""}`);
  }
  if (r.findings.length) {
    const max = opts.maxFindings ?? 25;
    lines.push("", bold(`Findings (${r.findings.length}):`));
    for (const f of r.findings.slice(0, max)) {
      lines.push(`  ${SECRET_CATEGORIES.has(f.category) ? yellow("●") : dim("○")} ${f.rule} ${dim(`@ ${f.where}`)}`);
    }
    if (r.findings.length > max) lines.push(dim(`  … ${r.findings.length - max} more (use --all-findings)`));
  }
  lines.push("", `${dim(`Known local secret values checked: ${r.knownSecretCount}`)}`);
  if (r.rescan.length) {
    lines.push(red(bold(`Final re-scan: ${plural(r.rescan.length, "issue")} — publishing blocked`)));
    for (const i of r.rescan) lines.push(red(`  ✗ ${i.rule}${i.length === undefined ? "" : ` (${plural(i.length, "char")})`}`));
  } else {
    lines.push(green("Final re-scan: clean ✓"));
  }
  lines.push(
    r.blocked
      ? red(bold("Status: BLOCKED — fix the source or add an allowlist entry"))
      : r.clean
        ? green(bold("Status: CLEAN — safe to publish with --yes"))
        : yellow(bold("Status: NEEDS REVIEW — secrets were redacted; review findings before publishing")),
  );
  return lines.join("\n");
}
