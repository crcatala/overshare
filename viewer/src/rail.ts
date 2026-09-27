import { formatCost, formatTokens } from "../../src/format.ts";
import { contextTokens, totalTokens, type NormalizedSession, type ResponseUsage, type Usage } from "../../src/schema.ts";
import { h, withTooltip } from "./dom.ts";

/**
 * Token rail: per turn, one column per model response.
 *  - Context chart: column height = prompt size (cache read / cache write / new input),
 *    scaled to the session's peak context, so context growth and compaction are visible.
 *  - Output chart: a separate row with its own scale (output is orders of magnitude
 *    smaller than context; stacking both on one axis would hide it).
 */

export interface RailScale {
  peakContext: number;
  peakOutput: number;
  /** Cumulative session usage after each response id. */
  cumulative: Map<string, { tokens: number; cost?: number }>;
  byTurn: Map<number, ResponseUsage[]>;
}

export function buildScale(session: NormalizedSession): RailScale {
  let peakContext = 1;
  let peakOutput = 1;
  let running = 0;
  let cost: number | undefined;
  const cumulative = new Map<string, { tokens: number; cost?: number }>();
  const byTurn = new Map<number, ResponseUsage[]>();
  for (const r of session.responses) {
    peakContext = Math.max(peakContext, contextTokens(r.usage));
    peakOutput = Math.max(peakOutput, r.usage.output);
    running += totalTokens(r.usage);
    if (r.usage.cost !== undefined) cost = (cost ?? 0) + r.usage.cost;
    cumulative.set(r.id, { tokens: running, ...(cost !== undefined ? { cost } : {}) });
    const list = byTurn.get(r.turn) ?? [];
    list.push(r);
    byTurn.set(r.turn, list);
  }
  return { peakContext, peakOutput, cumulative, byTurn };
}

const CONTEXT_H = 56;
const OUTPUT_H = 22;
const SEGMENTS: [keyof Usage, string][] = [
  ["cacheRead", "seg-cache-read"],
  ["cacheWrite", "seg-cache-write"],
  ["input", "seg-input"],
];

function sumUsage(list: ResponseUsage[]): Usage {
  const u: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
  for (const r of list) {
    u.input += r.usage.input;
    u.output += r.usage.output;
    u.cacheRead += r.usage.cacheRead;
    u.cacheWrite += r.usage.cacheWrite;
    u.reasoning += r.usage.reasoning;
    if (r.usage.cost !== undefined) u.cost = (u.cost ?? 0) + r.usage.cost;
  }
  return u;
}

function tooltipLines(r: ResponseUsage, index: number, count: number): string[] {
  const u = r.usage;
  return [
    `Response ${index + 1} of ${count}${r.model ? ` · ${r.model}` : ""}`,
    `Context ${formatTokens(contextTokens(u))}: cache read ${formatTokens(u.cacheRead)} · cache write ${formatTokens(u.cacheWrite)} · new ${formatTokens(u.input)}`,
    `Output ${formatTokens(u.output)}${u.reasoning ? ` (thinking ${formatTokens(u.reasoning)})` : ""}${u.cost !== undefined ? ` · ${formatCost(u.cost)}` : ""}`,
  ];
}

export function renderRail(turnIndex: number, scale: RailScale): HTMLElement | null {
  const list = scale.byTurn.get(turnIndex);
  if (!list || list.length === 0) return null;
  const n = list.length;
  const width = Math.max(2, Math.min(12, Math.floor((232 - (n - 1) * 2) / n)));

  const contextRow = h("div", { class: "cols", role: "img", "aria-label": `Context size for ${n} responses` });
  contextRow.style.height = `${CONTEXT_H}px`;
  const outputRow = h("div", { class: "cols cols-output", role: "img", "aria-label": `Output tokens for ${n} responses` });
  outputRow.style.height = `${OUTPUT_H}px`;

  list.forEach((r, i) => {
    const ctx = contextTokens(r.usage);
    const col = h("div", { class: "col", tabindex: "0" });
    col.style.width = `${width}px`;
    const totalH = Math.max(2, Math.round((ctx / scale.peakContext) * CONTEXT_H));
    // Stack segments bottom-up; each keeps a 1px minimum only if non-zero.
    for (const [key, cls] of SEGMENTS) {
      const v = r.usage[key] ?? 0;
      if (!v) continue;
      const seg = h("div", { class: `seg ${cls}` });
      seg.style.height = `${Math.max(1, (v / Math.max(1, ctx)) * totalH)}px`;
      col.append(seg);
    }
    withTooltip(col, () => tooltipLines(r, i, n));
    contextRow.append(col);

    const out = h("div", { class: "col", tabindex: "-1" });
    out.style.width = `${width}px`;
    const bar = h("div", { class: "seg seg-output" });
    bar.style.height = `${Math.max(r.usage.output ? 2 : 0, Math.round((r.usage.output / scale.peakOutput) * OUTPUT_H))}px`;
    out.append(bar);
    withTooltip(out, () => tooltipLines(r, i, n));
    outputRow.append(out);
  });

  const turn = sumUsage(list);
  const last = scale.cumulative.get(list[list.length - 1]!.id);
  const cachedPct = contextTokens(turn) ? Math.round((turn.cacheRead / contextTokens(turn)) * 100) : 0;
  const peak = Math.max(...list.map((r) => contextTokens(r.usage)));
  return h(
    "aside",
    { class: "rail", "aria-label": "Token usage for this turn" },
    h("div", { class: "rail-label" }, `${n} ${n === 1 ? "response" : "responses"} · context up to ${formatTokens(peak)}`),
    contextRow,
    h("div", { class: "rail-label rail-label-sm" }, "output"),
    outputRow,
    h(
      "dl",
      { class: "rail-stats" },
      h("dt", {}, "Turn"),
      h(
        "dd",
        {},
        `${formatTokens(totalTokens(turn))} tok · ${cachedPct}% cached · out ${formatTokens(turn.output)}${turn.reasoning ? ` · think ${formatTokens(turn.reasoning)}` : ""}${turn.cost !== undefined ? ` · ${formatCost(turn.cost)}` : ""}`,
      ),
      h("dt", {}, "Session"),
      h("dd", {}, `${formatTokens(last?.tokens ?? 0)} tok${last?.cost !== undefined ? ` · ${formatCost(last.cost)}` : ""}`),
    ),
  );
}

export function railLegend(): HTMLElement {
  const item = (cls: string, label: string) => h("span", { class: "legend-item" }, h("span", { class: `swatch ${cls}` }), label);
  return h(
    "div",
    { class: "legend", "aria-label": "Token chart legend" },
    h("span", { class: "legend-title" }, "Context"),
    item("seg-cache-read", "cache read"),
    item("seg-cache-write", "cache write"),
    item("seg-input", "new input"),
    h("span", { class: "legend-title" }, "Output"),
    item("seg-output", "output"),
  );
}
