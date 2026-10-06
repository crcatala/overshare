import { formatBytes, formatCacheSummary, formatSessionCost, formatTokens, formatUsageTotals, plural } from "./format.js";
import type { ShareReport } from "./pipeline.js";
import { SECRET_CATEGORIES, type RedactionCategory } from "./redact/index.js";
import { KNOWN_SOURCE_LABELS, type KnownSourceUse } from "./redact/known-values.js";
import { formatSourceLines } from "./redact/source-lines.js";
import { stripControls } from "./sanitize.js";
import { totalTokens } from "./schema.js";

/** Which sources supplied exact secret values, e.g. `env (4), project .env (2); not read: credential files, gh auth token (disabled)`. Names and counts only. */
export function formatKnownSources(sources: KnownSourceUse[]): string {
  const read = sources.filter((u) => u.enabled).map((u) => `${KNOWN_SOURCE_LABELS[u.id]} (${u.count})`);
  const off = sources.filter((u) => !u.enabled).map((u) => KNOWN_SOURCE_LABELS[u.id]);
  return `${read.length ? read.join(", ") : "none"}${off.length ? `; not read: ${off.join(", ")} (disabled)` : ""}`;
}

/** Human-readable redaction report: rules, locations and counts, never secret values or the text around them. */
export function formatReport(r: ShareReport, opts: { maxFindings?: number; color?: boolean; transcriptPath?: string } = {}): string {
  const color = (code: number) => (s: string) => (opts.color ? `\x1b[${code}m${s}\x1b[0m` : s);
  const bold = color(1);
  const dim = color(2);
  const red = color(31);
  const green = color(32);
  const yellow = color(33);
  const lines: string[] = [];
  const s = r.stats;
  lines.push(bold(`overshare report · ${r.harness} · ${r.sessionId.slice(0, 8)} · mode=${r.mode}`));
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
  if (r.systemPrompt) {
    lines.push("", bold("Included on request:"));
    lines.push(`  system prompt (${plural(r.systemPrompt.sections, "section")}, ${formatTokens(r.systemPrompt.chars)} chars), redacted like the rest`);
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
  lines.push("", dim(`Known values: ${formatKnownSources(r.knownSources)}`));
  if (r.rescan.length) {
    lines.push(red(bold(`Final re-scan: ${plural(r.rescan.length, "issue")} — publishing blocked`)));
    for (const i of r.rescan) lines.push(red(`  ✗ ${i.rule}${i.length === undefined ? "" : ` (${plural(i.length, "char")})`}${i.location ? ` @ ${i.location}` : ""}${i.source ? ` · ${formatSourceLines(i.source)}` : ""}`));
    if (r.rescan.some((i) => i.source)) lines.push(dim(`  Line numbers are of the transcript${opts.transcriptPath ? ` (${stripControls(opts.transcriptPath)})` : ""}.`));
  } else {
    lines.push(green("Final re-scan: clean ✓"));
  }
  if (r.suspicious.length) {
    const max = opts.maxFindings ?? 25;
    lines.push(yellow(bold(`Suspicious: ${plural(r.suspicious.length, "value")} could not be redacted and ${r.suspicious.length === 1 ? "is" : "are"} still in the payload`)));
    for (const i of r.suspicious.slice(0, max)) {
      lines.push(yellow(`  ? ${i.rule} (${plural(i.length, "char")}${i.occurrences > 1 ? `, ×${i.occurrences}` : ""}) `) + dim(`@ ${i.location}${i.source ? ` · ${formatSourceLines(i.source)}` : ""}`));
    }
    if (r.suspicious.length > max) lines.push(dim(`  … ${r.suspicious.length - max} more (use --all-findings)`));
    lines.push(
      dim(`  Look at these places in the transcript${opts.transcriptPath ? ` (${stripControls(opts.transcriptPath)})` : ""} (turn numbers as in \`overshare browse\`, line numbers of the file).`),
      dim("  A value that is fine can be added to redact.allowlist. This check cannot see secrets that have no recognizable format."),
    );
  }
  lines.push(
    r.blocked
      ? red(bold("Status: BLOCKED — fix the source or add an allowlist entry"))
      : r.suspicious.length
        ? yellow(bold("Status: NEEDS CONFIRMATION — suspicious values are still in the payload; inspect them before publishing"))
        : r.clean
          ? green(bold("Status: CLEAN — safe to publish with --yes"))
          : yellow(bold("Status: NEEDS REVIEW — secrets were redacted; review findings before publishing")),
  );
  return lines.join("\n");
}
