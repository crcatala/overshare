/**
 * The token rail: session totals, context size per turn (the turn in view is marked;
 * click a column to jump there), and the in-view turn's model calls in detail.
 *
 * Context columns stack cache read / cache write / new input of a prompt. Both charts
 * share one scale — the session's largest prompt and largest output — so a turn's calls
 * can be compared with each other and with the rest of the session (growth and
 * compaction show). Output has its own row and scale: it is orders of magnitude smaller.
 */
import { formatCost, formatTokens, plural } from "../../src/format.ts";
import { contextTokens, totalTokens, type NormalizedSession, type ResponseUsage, type Usage } from "../../src/schema.ts";
import { groupShell, isExecTool, tallyCommands } from "./commands.ts";
import { h, hideTooltip, withTooltip } from "./dom.ts";
import { svg } from "./el.ts";
import { closeHoverCard, hoverCard } from "./popover.ts";
import type { ToolCall, TurnInfo } from "./transcript.ts";

const SEGMENTS: [keyof Usage, string, string][] = [
  ["cacheRead", "seg-cache-read", "cache read"],
  ["cacheWrite", "seg-cache-write", "cache write"],
  ["input", "seg-input", "new input"],
];

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

interface Scale {
  context: number;
  output: number;
}

function chart(cols: Column[], scale: Scale, opts: { onPick?: (c: Column) => void; label: string; ctxH?: number; outH?: number }) {
  const cells: HTMLElement[] = [];
  const ctxH = opts.ctxH ?? 48;
  const outH = opts.outH ?? 16;
  const ctxRow = h("div", { class: "cols" });
  ctxRow.style.height = `${ctxH}px`;
  const outRow = h("div", { class: "cols cols-out" });
  outRow.style.height = `${outH}px`;
  for (const c of cols) {
    const ctx = contextTokens(c.context);
    const col = h(opts.onPick ? "button" : "div", { class: "col", type: opts.onPick ? "button" : undefined, onclick: opts.onPick ? () => opts.onPick!(c) : undefined, "aria-label": c.tip()[0] });
    const total = Math.max(ctx ? 2 : 0, Math.round((Math.min(ctx, scale.context) / scale.context) * ctxH));
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
    bar.style.height = `${Math.max(c.output ? 2 : 0, Math.round((Math.min(c.output, scale.output) / scale.output) * outH))}px`;
    out.append(bar);
    withTooltip(out, c.tip);
    outRow.append(out);
    cells.push(col, out);
  }
  const el = h(
    "div",
    { class: "chart", role: "img", "aria-label": opts.label },
    h("div", { class: "chart-row" }, ctxRow, h("span", { class: "chart-axis" }, formatTokens(scale.context))),
    h("div", { class: "chart-row" }, outRow, h("span", { class: "chart-axis" }, formatTokens(scale.output))),
  );
  const setActive = (turn: number) => {
    cols.forEach((c, i) => {
      const on = c.turns.includes(turn);
      cells[i * 2]?.classList.toggle("on", on);
      cells[i * 2 + 1]?.classList.toggle("on", on);
    });
    el.classList.toggle("has-on", cols.some((c) => c.turns.includes(turn)));
  };
  return { el, setActive };
}

const CONTEXT_BY_TURN_HELP = [
  "Top: the largest prompt sent to the model in each turn (cache read, cache write, new input).",
  "Bottom: the output the turn produced. Click a bar to jump to its turn.",
];
const TURN_HELP = ["One bar per model call in this turn: the prompt it was sent (top) and its output (bottom).", "Every turn uses the same scale, so turns can be compared."];

function infoIcon(): SVGElement {
  return svg(
    "svg",
    { viewBox: "0 0 16 16", width: "12", height: "12", fill: "none", stroke: "currentColor", "stroke-width": "1.4", "stroke-linecap": "round", "aria-hidden": "true" },
    svg("circle", { cx: "8", cy: "8", r: "6.3" }),
    svg("path", { d: "M8 7.3v3.9" }),
    svg("circle", { cx: "8", cy: "4.9", r: "0.5", fill: "currentColor", stroke: "none" }),
  );
}

let helpIds = 0;

/** A chart heading whose explanation shows on hover/focus (and is read out as a description). */
function helpHeading(label: string, help: string[], ...extra: (Node | null)[]): HTMLElement {
  const id = `chart-help-${++helpIds}`;
  const target = h("span", { class: "help", tabindex: "0", "aria-describedby": id }, label, infoIcon());
  // To the left of the rail, so it never covers the charts it explains.
  withTooltip(target, () => [label, ...help], { anchor: "left", beside: () => target.closest(".rail") ?? target, className: "tip-help" });
  return h("h3", {}, target, h("span", { class: "sr-only", id }, help.join(" ")), ...extra);
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
    `Model call ${i + 1} of ${n}${r.model ? ` · ${r.model}` : ""}`,
    `context ${formatTokens(contextTokens(u))}: cache read ${formatTokens(u.cacheRead)} · write ${formatTokens(u.cacheWrite)} · new ${formatTokens(u.input)}`,
    `output ${formatTokens(u.output)}${u.reasoning ? ` (thinking ${formatTokens(u.reasoning)})` : ""}${u.cost !== undefined ? ` · ${formatCost(u.cost)}` : ""}`,
  ];
}

/** Programs listed under a shell tool in the rail; the rest are summed. */
const SHELL_ROWS = 8;

/** The list a tool row opens on hover: its calls, each a line that jumps to it. */
function callsCard(title: string, count: number, calls: (ToolCall & { turn: number })[], onPick: (id: string) => void): HTMLElement {
  return h(
    "div",
    { class: "hc" },
    h("div", { class: "hc-head" }, h("span", { class: "hc-title" }, title), h("span", { class: "hc-count" }, plural(count, "call"))),
    h(
      "div",
      { class: "hc-list" },
      ...calls.map((c) =>
        h(
          "button",
          { type: "button", class: `hc-item${c.error ? " is-error" : ""}`, "data-hc-item": "", title: c.preview, onclick: () => onPick(c.id) },
          h("span", { class: "hc-turn" }, c.turn ? String(c.turn) : "·"),
          h("span", { class: "hc-text" }, c.preview),
          c.count && c.count > 1 ? h("span", { class: "hc-n" }, `×${c.count}`) : null,
          c.error ? h("span", { class: "hc-err" }, "error") : null,
        ),
      ),
    ),
  );
}

/** Shell calls by program, per shell tool name. Empty for a view that dropped the commands (minimal). */
function shellBreakdown(session: NormalizedSession): Map<string, [program: string, count: number][]> {
  const commands = new Map<string, string[]>();
  const add = (tool: string, list: string[]) => commands.set(tool, [...(commands.get(tool) ?? []), ...list]);
  for (const turn of session.turns) {
    for (const step of turn.steps) {
      if (step.kind === "tool" && isExecTool(step.name)) {
        const input = (step.input ?? {}) as Record<string, unknown>;
        const cmd = typeof input.command === "string" ? input.command : typeof input.cmd === "string" ? input.cmd : step.summary;
        add(step.name, [cmd]);
      } else if (step.kind === "toolGroup") {
        const shell = groupShell(step);
        if (shell) add(shell.call.name, shell.commands);
      }
    }
  }
  const out = new Map<string, [string, number][]>();
  for (const [tool, list] of commands) {
    const tally = tallyCommands(list);
    if (tally.length) out.set(tool, tally);
  }
  return out;
}

/**
 * `onJump` goes to a turn (the context chart); `onJumpTo` to a step (a call picked from a
 * tool row's list).
 */
export function renderTokenRail(session: NormalizedSession, turns: TurnInfo[], onJump: (turn: number) => void, onJumpTo?: (id: string) => void) {
  const st = session.stats;
  const total = totalTokens(st.tokens);
  const ctxAll = contextTokens(st.tokens);
  const cachedPct = ctxAll ? Math.round((st.tokens.cacheRead / ctxAll) * 100) : 0;

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
  const turnScale: Scale = { context: Math.max(1, ...turnCols.map((c) => contextTokens(c.context))), output: Math.max(1, ...turnCols.map((c) => c.output)) };
  // Per-call charts share one session-wide scale, so turns can be compared.
  const callScale: Scale = { context: Math.max(1, ...session.responses.map((r) => contextTokens(r.usage))), output: Math.max(1, ...session.responses.map((r) => r.usage.output)) };
  const sessionChart = chart(bucket(turnCols, 90), turnScale, { onPick: (c) => onJump(c.turns[0]!), label: `Context size per turn for ${plural(withResponses.length, "turn")}` });

  const turnBox = h("div", { class: "rail-turn" });
  const tools = Object.entries(st.tools).sort((a, b) => b[1] - a[1]);
  const maxTool = tools[0]?.[1] ?? 1;
  const shell = shellBreakdown(session);
  const calls = turns.flatMap((t) => t.calls.map((c) => ({ ...c, turn: t.ordinal })));
  /** Shell tools whose full program list is showing. */
  const expanded = new Set<string>();

  /** `program`: only that program's calls; null: the shell calls that couldn't be named; undefined: all of the tool's. */
  const toolRow = (name: string, count: number, program?: string | null) => {
    const sub = program !== undefined;
    const label = program ?? name;
    const bar = h("span", { class: "bar" });
    bar.style.setProperty("--w", `${Math.max(3, (count / maxTool) * 100)}%`);
    const row = h("div", { class: `bars-row${sub ? " bars-sub" : ""}` }, h("span", { class: "bars-name", title: program === null ? `${name}: other` : sub ? `${name}(${program})` : name }, program === null ? "other" : label), h("span", { class: "bars-track" }, bar), h("span", { class: "bars-n" }, String(count)));
    const mine = calls.filter((c) => c.tool === name && (program === undefined || (program === null ? !c.program : c.program === program)));
    if (mine.length) {
      hoverCard(row, {
        label: `${name} calls`,
        beside: () => row.closest(".rail") ?? row,
        build: (close) => callsCard(program === undefined ? name : program === null ? `${name} · other` : `${name}(${program})`, count, mine, (id) => {
          close();
          onJumpTo?.(id);
        }),
      });
    }
    return row;
  };

  const toolRows = ([name, count]: [string, number]): HTMLElement[] => {
    const parts = shell.get(name);
    if (!parts) return [toolRow(name, count)];
    // The shell total stays on its own row; what it ran is nested below it.
    const named = parts.reduce((n, [, k]) => n + k, 0);
    const unnamed = count - named;
    const rows: [string | null, number][] = [...parts, ...(unnamed > 0 ? [[null, unnamed] as [null, number]] : [])];
    const open = expanded.has(name);
    const hidden = rows.length > SHELL_ROWS + 1 ? rows.slice(SHELL_ROWS) : [];
    const shown = open || !hidden.length ? rows : rows.slice(0, SHELL_ROWS);
    const list: HTMLElement[] = [toolRow(name, count), ...shown.map(([program, k]) => toolRow(name, k, program))];
    if (hidden.length) {
      list.push(
        h(
          "button",
          {
            type: "button",
            class: "bars-more bars-sub bars-toggle",
            "aria-expanded": String(open),
            onclick: () => {
              if (open) expanded.delete(name);
              else expanded.add(name);
              fill();
            },
          },
          open ? "show fewer" : `+${hidden.length} more`,
        ),
      );
    }
    return list;
  };

  const toolBox = h("div", { class: "bars" });
  const fill = () => {
    closeHoverCard();
    toolBox.replaceChildren(...tools.slice(0, 12).flatMap(toolRows), ...(tools.length > 12 ? [h("div", { class: "bars-more" }, `+${plural(tools.length - 12, "more tool")}`)] : []));
  };
  fill();
  const toolList = tools.length ? toolBox : null;
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
    withResponses.length
      ? h(
          "section",
          { class: "rail-sec" },
          helpHeading("Context by turn", CONTEXT_BY_TURN_HELP),
          sessionChart.el,
          legend(),
        )
      : null,
    withResponses.length ? h("section", { class: "rail-sec" }, turnBox) : null,
    toolList ? h("section", { class: "rail-sec" }, h("h3", {}, `Tools · ${st.toolCalls}`), toolList) : null,
    files ? h("section", { class: "rail-sec" }, h("h3", {}, "Files"), dl([["read", String(st.files.read)], ["edited", String(st.files.edited)], ["written", String(st.files.written)]])) : null,
  );

  let current = -1;
  const setActive = (turnIndex: number) => {
    if (turnIndex === current) return;
    current = turnIndex;
    sessionChart.setActive(turnIndex);
    // The turn box is rebuilt below; a tooltip from one of its bars would outlive it.
    if (turnBox.matches(":hover")) hideTooltip();
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
    const respChart = chart(bucket(respCols, 60), callScale, { label: `Context per model call for ${plural(n, "call")}`, ctxH: 36, outH: 12 });
    turnBox.replaceChildren(
      helpHeading(t.ordinal ? `Turn ${t.ordinal}` : "Start", TURN_HELP, h("span", { class: "h3-meta" }, plural(n, "model call"))),
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
