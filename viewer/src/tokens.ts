/**
 * The token rail: session totals, context size per turn (the turn in view is marked;
 * click a column to jump there), and the in-view turn's responses in detail.
 *
 * Context columns stack cache read / cache write / new input of the turn's largest
 * prompt, scaled to the session peak, so growth and compaction are visible. Output has
 * its own row and scale (it is orders of magnitude smaller). Variants draw columns as
 * DOM bars or as block-character sparklines.
 */
import { formatCost, formatTokens, plural } from "../../src/format.ts";
import { contextTokens, totalTokens, type NormalizedSession, type ResponseUsage, type Usage } from "../../src/schema.ts";
import { h, withTooltip } from "./dom.ts";
import type { TurnInfo } from "./transcript.ts";
import type { Variant } from "./variants.ts";

const SEGMENTS: [keyof Usage, string, string][] = [
  ["cacheRead", "seg-cache-read", "cache read"],
  ["cacheWrite", "seg-cache-write", "cache write"],
  ["input", "seg-input", "new input"],
];
const BLOCKS = " ▁▂▃▄▅▆▇█";

interface Column {
  /** Turn indexes this column covers (several when bucketed). */
  turns: number[];
  context: Usage;
  output: number;
  tip: () => string[];
}

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

const peakOf = (list: ResponseUsage[]): ResponseUsage | undefined => list.reduce<ResponseUsage | undefined>((best, r) => (!best || contextTokens(r.usage) > contextTokens(best.usage) ? r : best), undefined);

/** Merge neighbours until there are at most `max` columns (keeping each bucket's peak). */
function bucket(cols: Column[], max: number): Column[] {
  if (cols.length <= max) return cols;
  const size = Math.ceil(cols.length / max);
  const out: Column[] = [];
  for (let i = 0; i < cols.length; i += size) {
    const group = cols.slice(i, i + size);
    const peak = group.reduce((a, b) => (contextTokens(b.context) > contextTokens(a.context) ? b : a));
    const output = group.reduce((n, c) => n + c.output, 0);
    const turns = group.flatMap((c) => c.turns);
    out.push({ turns, context: peak.context, output, tip: () => [`${plural(turns.length, "turn")} (${group[0]!.tip()[0]} – ${group[group.length - 1]!.tip()[0]})`, `peak context ${formatTokens(contextTokens(peak.context))} · output ${formatTokens(output)}`] });
  }
  return out;
}

function chart(cols: Column[], style: Variant["chart"], opts: { onPick?: (c: Column) => void; label: string; ctxH?: number; outH?: number }) {
  const peakCtx = Math.max(1, ...cols.map((c) => contextTokens(c.context)));
  const peakOut = Math.max(1, ...cols.map((c) => c.output));
  const cells: HTMLElement[] = [];
  const pick = (c: Column) => (opts.onPick ? () => opts.onPick!(c) : undefined);
  let el: HTMLElement;
  if (style === "blocks") {
    const row = (value: (c: Column) => number, peak: number, cls: string) =>
      h(
        "div",
        { class: `spark ${cls}` },
        ...cols.map((c) => {
          const v = value(c);
          const level = v ? Math.max(1, Math.round((v / peak) * 8)) : 0;
          const cell = h(opts.onPick ? "button" : "span", { class: "spark-c", type: opts.onPick ? "button" : undefined, onclick: pick(c) }, BLOCKS[level] === " " ? "·" : BLOCKS[level]!);
          withTooltip(cell, c.tip);
          cells.push(cell);
          return cell;
        }),
      );
    el = h("div", { class: "chart chart-blocks", role: "img", "aria-label": opts.label }, row((c) => contextTokens(c.context), peakCtx, "spark-ctx"), row((c) => c.output, peakOut, "spark-out"));
  } else {
    const ctxH = opts.ctxH ?? 48;
    const outH = opts.outH ?? 16;
    const ctxRow = h("div", { class: "cols" });
    ctxRow.style.height = `${ctxH}px`;
    const outRow = h("div", { class: "cols cols-out" });
    outRow.style.height = `${outH}px`;
    for (const c of cols) {
      const ctx = contextTokens(c.context);
      const col = h(opts.onPick ? "button" : "div", { class: "col", type: opts.onPick ? "button" : undefined, onclick: pick(c), "aria-label": c.tip()[0] });
      const total = Math.max(ctx ? 2 : 0, Math.round((ctx / peakCtx) * ctxH));
      for (const [key, cls] of SEGMENTS) {
        const v = c.context[key] ?? 0;
        if (!v) continue;
        const seg = h("div", { class: `seg ${cls}` });
        seg.style.height = `${Math.max(1, (v / Math.max(1, ctx)) * total)}px`;
        col.append(seg);
      }
      withTooltip(col, c.tip);
      ctxRow.append(col);
      const out = h("div", { class: "col" });
      const bar = h("div", { class: "seg seg-output" });
      bar.style.height = `${Math.max(c.output ? 2 : 0, Math.round((c.output / peakOut) * outH))}px`;
      out.append(bar);
      withTooltip(out, c.tip);
      outRow.append(out);
      cells.push(col, out);
    }
    el = h("div", { class: "chart chart-bars", role: "img", "aria-label": opts.label }, ctxRow, outRow);
  }
  const setActive = (turn: number) => {
    cols.forEach((c, i) => {
      const on = c.turns.includes(turn);
      if (style === "blocks") {
        cells[i]?.classList.toggle("on", on);
        cells[i + cols.length]?.classList.toggle("on", on);
      } else {
        cells[i * 2]?.classList.toggle("on", on);
        cells[i * 2 + 1]?.classList.toggle("on", on);
      }
    });
    el.classList.toggle("has-on", cols.some((c) => c.turns.includes(turn)));
  };
  return { el, setActive };
}

function dl(rows: [string, string | undefined][]): HTMLElement {
  return h("dl", { class: "kv" }, ...rows.filter(([, v]) => v !== undefined && v !== "").flatMap(([k, v]) => [h("dt", {}, k), h("dd", {}, v!)]));
}

function legend(): HTMLElement {
  return h(
    "div",
    { class: "legend", "aria-label": "Chart legend" },
    ...SEGMENTS.map(([, cls, label]) => h("span", { class: "legend-i" }, h("span", { class: `sw ${cls}` }), label)),
    h("span", { class: "legend-i" }, h("span", { class: "sw seg-output" }), "output"),
  );
}

function responseTip(r: ResponseUsage, i: number, n: number): string[] {
  const u = r.usage;
  return [
    `Response ${i + 1} of ${n}${r.model ? ` · ${r.model}` : ""}`,
    `context ${formatTokens(contextTokens(u))}: cache read ${formatTokens(u.cacheRead)} · write ${formatTokens(u.cacheWrite)} · new ${formatTokens(u.input)}`,
    `output ${formatTokens(u.output)}${u.reasoning ? ` (thinking ${formatTokens(u.reasoning)})` : ""}${u.cost !== undefined ? ` · ${formatCost(u.cost)}` : ""}`,
  ];
}

export function renderTokenRail(session: NormalizedSession, turns: TurnInfo[], variant: Variant, onJump: (turn: number) => void) {
  const st = session.stats;
  const total = totalTokens(st.tokens);
  const ctxAll = contextTokens(st.tokens);
  const cachedPct = ctxAll ? Math.round((st.tokens.cacheRead / ctxAll) * 100) : 0;
  const blocks = variant.chart === "blocks";

  // Running session totals after each turn.
  const running = new Map<number, { tokens: number; cost?: number }>();
  let acc = 0;
  let accCost: number | undefined;
  for (const t of turns) {
    for (const r of t.responses) {
      acc += totalTokens(r.usage);
      if (r.usage.cost !== undefined) accCost = (accCost ?? 0) + r.usage.cost;
    }
    running.set(t.index, { tokens: acc, ...(accCost !== undefined ? { cost: accCost } : {}) });
  }

  const withResponses = turns.filter((t) => t.responses.length);
  const turnCols: Column[] = withResponses.map((t) => {
    const peak = peakOf(t.responses)!;
    const out = t.responses.reduce((n, r) => n + r.usage.output, 0);
    const name = t.ordinal ? `Turn ${t.ordinal}` : "Start";
    return {
      turns: [t.index],
      context: peak.usage,
      output: out,
      tip: () => [name, `context up to ${formatTokens(contextTokens(peak.usage))} · output ${formatTokens(out)}`, `${plural(t.responses.length, "response")}${t.label ? ` · ${t.label.slice(0, 60)}` : ""}`],
    };
  });
  const sessionChart = chart(bucket(turnCols, blocks ? 32 : 90), variant.chart, { onPick: (c) => onJump(c.turns[0]!), label: `Context size per turn for ${plural(withResponses.length, "turn")}` });

  const turnBox = h("div", { class: "rail-turn" });
  const tools = Object.entries(st.tools).sort((a, b) => b[1] - a[1]);
  const maxTool = tools[0]?.[1] ?? 1;
  const toolList = tools.length
    ? h(
        "div",
        { class: "bars" },
        ...tools.slice(0, 12).map(([name, count]) => {
          const bar = blocks ? h("span", { class: "bar-t" }, "▇".repeat(Math.max(1, Math.round((count / maxTool) * 10)))) : h("span", { class: "bar" });
          if (!blocks) bar.style.setProperty("--w", `${Math.max(3, (count / maxTool) * 100)}%`);
          return h("div", { class: "bars-row" }, h("span", { class: "bars-name", title: name }, name), h("span", { class: "bars-track" }, bar), h("span", { class: "bars-n" }, String(count)));
        }),
        tools.length > 12 ? h("div", { class: "bars-more" }, `+${plural(tools.length - 12, "more tool")}`) : null,
      )
    : null;
  const files = st.files.read + st.files.edited + st.files.written;

  const el = h(
    "div",
    { class: "tokens" },
    h(
      "section",
      { class: "rail-sec" },
      h("h3", {}, "Session"),
      dl([
        ["tokens", formatTokens(total)],
        ["output", `${formatTokens(st.tokens.output)}${st.tokens.reasoning ? ` (${formatTokens(st.tokens.reasoning)} think)` : ""}`],
        ["peak ctx", formatTokens(st.peakContext)],
        ["cached", `${cachedPct}%`],
        ["cost", st.cost !== undefined ? formatCost(st.cost) : undefined],
        ["responses", String(session.responses.length)],
      ]),
    ),
    withResponses.length ? h("section", { class: "rail-sec" }, h("h3", {}, "Context by turn"), sessionChart.el, blocks ? null : legend()) : null,
    withResponses.length ? h("section", { class: "rail-sec" }, turnBox) : null,
    toolList ? h("section", { class: "rail-sec" }, h("h3", {}, `Tools · ${st.toolCalls}`), toolList) : null,
    files ? h("section", { class: "rail-sec" }, h("h3", {}, "Files"), dl([["read", String(st.files.read)], ["edited", String(st.files.edited)], ["written", String(st.files.written)]])) : null,
  );

  let current = -1;
  const setActive = (turnIndex: number) => {
    if (turnIndex === current) return;
    current = turnIndex;
    sessionChart.setActive(turnIndex);
    const t = turns.find((x) => x.index === turnIndex);
    if (!t || !t.responses.length) {
      turnBox.replaceChildren(h("h3", {}, t ? (t.ordinal ? `Turn ${t.ordinal}` : "Start") : "Turn"), h("p", { class: "rail-empty" }, "No model responses in this turn."));
      return;
    }
    const n = t.responses.length;
    const u = sumUsage(t.responses);
    const peak = Math.max(...t.responses.map((r) => contextTokens(r.usage)));
    const ctxSum = contextTokens(u);
    const run = running.get(t.index);
    const respCols: Column[] = t.responses.map((r, i) => ({ turns: [t.index], context: r.usage, output: r.usage.output, tip: () => responseTip(r, i, n) }));
    const respChart = chart(bucket(respCols, blocks ? 32 : 60), variant.chart, { label: `Context per response for ${plural(n, "response")}`, ctxH: 36, outH: 12 });
    turnBox.replaceChildren(
      h("h3", {}, t.ordinal ? `Turn ${t.ordinal}` : "Start", h("span", { class: "h3-meta" }, plural(n, "response"))),
      respChart.el,
      dl([
        ["context", `up to ${formatTokens(peak)}`],
        ["cached", ctxSum ? `${Math.round((u.cacheRead / ctxSum) * 100)}%` : undefined],
        ["output", `${formatTokens(u.output)}${u.reasoning ? ` (${formatTokens(u.reasoning)} think)` : ""}`],
        ["cost", u.cost !== undefined ? formatCost(u.cost) : undefined],
        ["so far", run ? `${formatTokens(run.tokens)}${run.cost !== undefined ? ` · ${formatCost(run.cost)}` : ""}` : undefined],
      ]),
    );
  };
  return { el, setActive };
}
