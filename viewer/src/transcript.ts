/**
 * The transcript as one DOM that every variant styles. Each entry is
 *   .entry.k-<kind>  >  .gut (role + time, shown or hidden per variant)  +  .body
 * Tool entries are one summary line plus a short preview of their output; the full
 * input/output is built only when opened. The same pass collects the outline the
 * contents rail shows.
 */
import { formatCost, formatDuration, formatTokens, plural } from "../../src/format.ts";
import { metaOf } from "../../src/harnesses/meta.ts";
import { contextTokens, type EventStep, type NormalizedSession, type ResponseUsage, type Step, type SubagentStep, type ThinkingStep, type ToolGroupStep, type ToolResult, type ToolStep, type Turn } from "../../src/schema.ts";
import { commandName, groupCalls, groupShell, isExecTool, type CallCount } from "./commands.ts";
import { h, markdown } from "./dom.ts";
import { warnIcon } from "./el.ts";
import { stepTokens, turnSubagents, turnSubagentsLine, type TurnSubagents } from "./subagents.ts";
import { firstLine, lineDiff, preview, splitLines, trimContext, type DiffLine } from "./text.ts";
import { cacheEventOf } from "./usageinfo.ts";

export type OutlineKind = "reply" | "tools" | "subagent" | "event" | "error";

export interface OutlineItem {
  id: string;
  kind: OutlineKind;
  label: string;
  error?: boolean;
  /** Every step the item stands for, when it is more than the one at `id` (a run of tool calls). */
  ids?: string[];
}

/** One tool call (or, in a brief/minimal view, one stand-in for several) for the rail's per-tool lists. */
export interface ToolCall {
  /** The step to jump to. */
  id: string;
  tool: string;
  /** For shell calls: the program, when it could be named. */
  program?: string;
  preview: string;
  error?: boolean;
  /** More than one call stood for by this entry (only in views that collapse steps). */
  count?: number;
}

export interface TurnInfo {
  index: number;
  /** 1-based prompt number, 0 for steps before the first prompt. */
  ordinal: number;
  id: string;
  el: HTMLElement;
  label: string;
  time?: string;
  command?: boolean;
  tools: number;
  errors: number;
  items: OutlineItem[];
  /** Every tool call in the turn, in order. */
  calls: ToolCall[];
  responses: ResponseUsage[];
  /** What the subagents launched in this turn add up to (absent in a prompts view, which keeps no steps). */
  subagents?: TurnSubagents;
  /** The DOM id of the first step each model call produced, to jump to it (empty where steps are not shown). */
  responseSteps: Map<string, string>;
}

const EVENT_LABEL: Record<string, string> = {
  model_change: "model",
  thinking_level: "thinking",
  compaction: "compaction",
  command: "command",
  skill: "skill",
  subagent_notice: "notice",
  interrupted: "interrupted",
  error: "error",
};

export function clock(iso?: string): string | undefined {
  if (!iso) return undefined;
  const d = new Date(iso);
  // Compact 24h times: they sit in narrow gutters and outline rows.
  return Number.isNaN(d.getTime()) ? undefined : d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
}

export interface TranscriptOptions {
  /** Show thinking text in full instead of a one-line preview that opens. */
  inlineThinking?: boolean;
}

interface Ctx extends TranscriptOptions {
  cwd?: string;
  byTurn: Map<number, ResponseUsage[]>;
}

/** Paths relative to the project, which is where almost every tool call points. */
export function relTo(cwd: string | undefined, text: string): string {
  if (!cwd) return text;
  return text.split(`${cwd}/`).join("");
}

const rel = (ctx: Ctx, text: string) => relTo(ctx.cwd, text);

/** The transcript entry ids: a turn's prompt, and each of its steps. */
export const promptId = (turn: number) => `turn-${turn}-prompt`;
export const stepId = (turn: number, i: number) => `s-${turn}-${i}`;

function gut(who: string, iso?: string): HTMLElement {
  const t = clock(iso);
  return h("div", { class: "gut", "aria-hidden": "true" }, h("span", { class: "who" }, who), t ? h("time", {}, t) : null);
}

function entry(kind: string, id: string, who: string, iso: string | undefined, ...body: (Node | null)[]): HTMLElement {
  return h("div", { class: `entry k-${kind}`, id }, gut(who, iso), h("div", { class: "body" }, ...body));
}

function pre(text: string, className = ""): HTMLElement {
  return h("pre", { class: `out ${className}`.trim() }, text);
}

function linesPre(lines: string[], className = ""): HTMLElement {
  return pre(lines.join("\n"), className);
}

function diffPre(lines: (DiffLine | { op: "…"; skipped: number })[]): HTMLElement {
  return h(
    "pre",
    { class: "out diff" },
    ...lines.map((d) =>
      d.op === "…"
        ? h("span", { class: "d-skip" }, `  ⋯ ${plural(d.skipped, "unchanged line")}\n`)
        : h("span", { class: d.op === "+" ? "d-add" : d.op === "-" ? "d-del" : "d-ctx" }, h("span", { class: "d-op", "aria-hidden": "true" }, d.op === " " ? " " : d.op), `${d.text}\n`),
    ),
  );
}

/**
 * A summary line that opens the full view. `previewEl` is shown until then; `build`
 * makes the full view on first open. `moreLabel` adds a "… +N lines" opener under
 * the preview.
 */
function expandable(
  entryEl: HTMLElement,
  line: HTMLElement,
  opts: { preview?: Node | null; more?: string; build?: () => Node },
): void {
  const body = entryEl.querySelector(":scope > .body") as HTMLElement;
  const prev = opts.preview ? h("div", { class: "tprev" }, opts.preview) : null;
  if (!opts.build) {
    body.append(h("div", { class: "tline" }, ...Array.from(line.childNodes)), ...(prev ? [prev] : []));
    return;
  }
  const button = h("button", { type: "button", class: "tline", "aria-expanded": "false" }, ...Array.from(line.childNodes));
  const full = h("div", { class: "tfull", hidden: true });
  let built = false;
  const toggle = () => {
    const open = button.getAttribute("aria-expanded") !== "true";
    if (open && !built) {
      built = true;
      full.append(opts.build!());
    }
    button.setAttribute("aria-expanded", String(open));
    entryEl.classList.toggle("open", open);
    full.hidden = !open;
    if (prev) prev.hidden = open;
  };
  button.addEventListener("click", toggle);
  if (prev && opts.more) prev.append(h("button", { type: "button", class: "more", onclick: toggle }, opts.more));
  body.append(button, ...(prev ? [prev] : []), full);
}

function toolLine(name: string, arg: string, meta?: string, error?: boolean): HTMLElement {
  return h(
    "span",
    {},
    h("span", { class: "tname" }, name),
    arg ? h("span", { class: "targ" }, arg) : null,
    meta ? h("span", { class: "tmeta" }, meta) : null,
    error ? h("span", { class: "tstat is-error" }, "error") : null,
  );
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function editDiffs(input: Record<string, unknown>): DiffLine[] | undefined {
  const pairs: [string, string][] = [];
  if (typeof input.old_string === "string") pairs.push([input.old_string, str(input.new_string) ?? ""]);
  else if (typeof input.oldText === "string") pairs.push([input.oldText, str(input.newText) ?? ""]);
  else if (Array.isArray(input.edits)) {
    for (const e of input.edits as Record<string, unknown>[]) pairs.push([str(e.oldText) ?? str(e.old_string) ?? "", str(e.newText) ?? str(e.new_string) ?? ""]);
  } else return undefined;
  const out: DiffLine[] = [];
  pairs.forEach(([a, b], i) => {
    if (i) out.push({ op: " ", text: "" });
    out.push(...lineDiff(a, b));
  });
  return out;
}

function resultNote(step: { result?: ToolResult }): string {
  const r = step.result;
  if (!r) return "";
  const parts = [r.images ? `${plural(r.images, "image")} omitted` : "", r.truncatedFrom ? `truncated from ${formatTokens(r.truncatedFrom)} chars when shared` : ""].filter(Boolean);
  return parts.join(" · ");
}

function renderTool(step: ToolStep, id: string, ctx: Ctx): HTMLElement {
  const input = (step.input ?? {}) as Record<string, unknown>;
  const result = step.result?.text ?? "";
  const lines = step.result ? splitLines(result) : [];
  const isError = Boolean(step.isError || step.result?.isError);
  const el = entry(`tool`, id, "tool", step.timestamp);
  el.dataset.action = step.action;
  if (isError) el.classList.add("is-error");
  const summary = rel(ctx, step.summary || "");
  const note = resultNote(step);
  const noteEl = note ? h("div", { class: "tnote" }, note) : null;

  const diff = step.action === "edit" ? editDiffs(input) : undefined;
  const command = str(input.command) ?? str(input.cmd);
  const content = step.action === "write" ? str(input.content) : undefined;

  let meta: string | undefined;
  let prev: Node | null = null;
  let more = 0;
  if (diff) {
    const adds = diff.filter((d) => d.op === "+").length;
    const dels = diff.filter((d) => d.op === "-").length;
    meta = `+${adds} −${dels}`;
    const trimmed = trimContext(diff, 1);
    const cap = 10;
    prev = diffPre(trimmed.slice(0, cap));
    more = trimmed.length > cap + 1 ? trimmed.length - cap : 0;
    if (!more) prev = diffPre(trimmed);
  } else if (step.action === "read") {
    meta = step.result ? plural(lines.length, "line") : undefined;
  } else if (content !== undefined) {
    meta = plural(splitLines(content).length, "line");
  } else if (step.result) {
    const p = preview(result, isError ? 6 : step.action === "web" ? 2 : 3);
    if (result.trim()) prev = linesPre(p.lines, isError ? "is-error" : "");
    more = p.more;
    if (step.action === "search" && result.trim()) meta = plural(lines.length, "line");
  }
  // A read/write result is the file: nothing to preview, but it opens to the content.
  const hasFull = Boolean(step.result?.text || step.input !== undefined);
  const build = hasFull
    ? () => {
        const parts: (Node | null)[] = [];
        if (diff) parts.push(diffPre(diff));
        else if (command !== undefined) {
          if (command.includes("\n") || command.length > summary.length + 1) parts.push(h("div", { class: "io" }, "command"), pre(command, "cmd"));
        } else if (content !== undefined) parts.push(pre(content));
        else if (step.action !== "read" && step.input !== undefined && Object.keys(input).length) parts.push(h("div", { class: "io" }, "input"), pre(rel(ctx, JSON.stringify(step.input, null, 2)), "json"));
        if (step.result && !(diff || content !== undefined) || (step.result && isError)) {
          if (parts.length) parts.push(h("div", { class: "io" }, isError ? "error" : "output"));
          parts.push(pre(result || "(empty)", isError ? "is-error" : ""));
        }
        if (noteEl) parts.push(noteEl.cloneNode(true));
        return h("div", {}, ...parts);
      }
    : undefined;
  const prevWrap = prev || noteEl ? h("div", {}, prev, noteEl) : null;
  expandable(el, toolLine(step.name, summary, meta, isError), { preview: prevWrap, more: more ? `… +${plural(more, "line")}` : undefined, build });
  return el;
}

function renderGroup(g: ToolGroupStep, id: string, ctx: Ctx): HTMLElement {
  const el = entry("group", id, "tools", g.timestamp);
  const errors = g.calls.reduce((n, c) => n + c.errors, 0);
  if (errors) el.classList.add("has-error");
  const chips = h(
    "span",
    { class: "chips" },
    ...groupCalls(g).map((c) =>
      h("span", { class: `chip${c.errors ? " is-error" : ""}`, title: c.errors ? `${plural(c.errors, "error")}` : undefined }, h("span", { class: "chip-name" }, c.label), c.count > 1 || c.errorsOnly ? h("span", { class: "chip-n" }, `×${c.count}`) : null),
    ),
    g.thinking ? h("span", { class: "chip chip-think" }, h("span", { class: "chip-name" }, "thinking"), h("span", { class: "chip-n" }, g.thinking.tokens ? formatTokens(g.thinking.tokens) : `×${g.thinking.blocks}`)) : null,
  );
  const touched = [
    g.files.edited.length ? `edited ${plural(g.files.edited.length, "file")}` : "",
    g.files.written.length ? `wrote ${plural(g.files.written.length, "file")}` : "",
    g.files.read.length ? `read ${plural(g.files.read.length, "file")}` : "",
  ].filter(Boolean);
  const line = h("span", {}, chips, touched.length ? h("span", { class: "tmeta" }, touched.join(" · ")) : null);
  const changed = [...g.files.edited, ...g.files.written].map((f) => rel(ctx, f));
  const cmds = g.commands.map((c) => rel(ctx, c));
  const prevLines = [...changed.slice(0, 4).map((f) => `~ ${f}`), ...cmds.slice(0, 3).map((c) => `$ ${c}`)];
  const hidden = Math.max(0, changed.length - 4) + Math.max(0, cmds.length - 3) + g.files.read.length;
  const hasDetail = cmds.length || g.files.read.length || changed.length;
  const list = (label: string, items: string[], prefix: string) =>
    items.length ? h("div", { class: "glist" }, h("div", { class: "io" }, `${label} (${items.length})`), pre(items.map((i) => `${prefix}${i}`).join("\n"))) : null;
  expandable(el, line, {
    preview: prevLines.length ? linesPre(prevLines, "glines") : null,
    more: hidden ? `… +${hidden} more` : undefined,
    build: hasDetail
      ? () =>
          h(
            "div",
            {},
            list("commands", cmds, "$ "),
            list("edited", g.files.edited.map((f) => rel(ctx, f)), "~ "),
            list("written", g.files.written.map((f) => rel(ctx, f)), "+ "),
            list("read", g.files.read.map((f) => rel(ctx, f)), "  "),
          )
      : undefined,
  });
  return el;
}

function renderThinking(t: ThinkingStep, id: string, ctx: Ctx): HTMLElement {
  const el = entry("think", id, "thinking", t.timestamp);
  const meta = [t.blocks > 1 ? `${t.blocks} blocks` : "", t.tokens ? `${formatTokens(t.tokens)} tok` : t.chars ? `${formatTokens(t.chars)} chars` : ""].filter(Boolean).join(" · ");
  if (ctx.inlineThinking && t.text) {
    el.classList.add("inline");
    el.querySelector(".body")!.append(markdown(t.text));
    return el;
  }
  expandable(el, toolLine("thinking", t.text ? firstLine(t.text, 140) : "", meta), { build: t.text ? () => markdown(t.text ?? "") : undefined });
  return el;
}

/** The subagent's usage by token class, models and nested agents: what the line's total is made of. */
function subagentUsageDetail(u: NonNullable<SubagentStep["usage"]>): string {
  const classes = [
    u.cacheRead !== undefined ? `cache read ${formatTokens(u.cacheRead)}` : "",
    u.cacheWrite !== undefined ? `cache write ${formatTokens(u.cacheWrite)}` : "",
    u.input !== undefined ? `uncached input ${formatTokens(u.input)}` : "",
    u.output !== undefined ? `output ${formatTokens(u.output)}` : "",
  ].filter(Boolean);
  return [...classes, u.models?.length ? u.models.join(", ") : "", u.nested ? `incl. ${plural(u.nested, "nested agent")}` : ""].filter(Boolean).join(" · ");
}

function renderSubagent(s: SubagentStep, id: string): HTMLElement {
  const el = entry("sub", id, "agent", s.timestamp);
  if (s.isError) el.classList.add("is-error");
  const u = s.usage;
  const tokens = u ? stepTokens(u) : undefined;
  const stats = u
    ? [
        tokens ? `${formatTokens(tokens)} tokens` : "",
        u.turns ? plural(u.turns, "model call") : "",
        u.toolUses ? plural(u.toolUses, "tool call") : "",
        u.durationMs ? formatDuration(u.durationMs) : "",
        u.cost !== undefined ? formatCost(u.cost) : "",
      ].filter(Boolean)
    : [];
  const who = [s.agents.length ? s.agents.join(", ") : "", s.mode ?? "", s.async ? "async" : ""].filter(Boolean).join(" · ");
  const p = s.result ? preview(s.result.text, 3) : undefined;
  const detail = u && tokens ? subagentUsageDetail(u) : "";
  expandable(el, toolLine(s.tool, who, stats.join(" · "), s.isError), {
    preview: h("div", {}, s.description ? h("div", { class: "sub-desc" }, s.description) : null, p && s.result?.text.trim() ? linesPre(p.lines) : null),
    more: p?.more ? `… +${plural(p.more, "line")}` : undefined,
    build: s.result || detail ? () => h("div", {}, detail ? h("p", { class: "sub-usage" }, detail) : null, s.result ? pre(s.result.text) : null, resultNote(s) ? h("div", { class: "tnote" }, resultNote(s)) : null) : undefined,
  });
  return el;
}

function renderEvent(e: EventStep, id: string): HTMLElement {
  const el = entry("event", id, EVENT_LABEL[e.event] ?? "event", e.timestamp);
  el.dataset.event = e.event;
  if (e.event === "error" || e.event === "interrupted") el.classList.add("is-error");
  expandable(el, h("span", {}, h("span", { class: "ev-text" }, e.text)), {
    build: e.detail ? () => (e.event === "compaction" ? markdown(e.detail ?? "") : pre(e.detail ?? "")) : undefined,
  });
  return el;
}

function renderStep(step: Step, id: string, ctx: Ctx): HTMLElement {
  switch (step.kind) {
    case "text":
      return entry("text", id, "agent", step.timestamp, markdown(step.text));
    case "thinking":
      return renderThinking(step, id, ctx);
    case "tool":
      return renderTool(step, id, ctx);
    case "toolGroup":
      return renderGroup(step, id, ctx);
    case "subagent":
      return renderSubagent(step, id);
    case "event":
      return renderEvent(step, id);
    default:
      return unsupported(id, (step as { kind?: unknown }).kind, (step as { timestamp?: string }).timestamp);
  }
}

/**
 * A step this viewer can't draw: a kind from a newer format, or one whose data isn't what its kind promises.
 * It stands as a placeholder so one step never costs the reader the rest of the session.
 */
function unsupported(id: string, kind: unknown, iso: string | undefined, broken = false): HTMLElement {
  const name = typeof kind === "string" && kind ? kind : "unknown";
  const el = entry("unsupported", id, "?", iso, warnIcon(), h("span", { class: "tname" }, name), h("span", { class: "tmeta" }, broken ? "couldn't be shown" : "not supported by this viewer"));
  el.dataset.kind = name;
  return el;
}

/** renderStep, with a placeholder for a step that throws. */
function renderStepSafe(step: Step, id: string, ctx: Ctx): HTMLElement {
  try {
    return renderStep(step, id, ctx);
  } catch {
    return unsupported(id, step?.kind, step?.timestamp, true);
  }
}

/** The harness's system prompt, shared on request (full mode only): one closed line above the first turn. */
function renderSystemPrompt(sections: unknown): HTMLElement | null {
  if (!Array.isArray(sections)) return null;
  const parts = sections.filter((p): p is string => typeof p === "string" && p.trim() !== "");
  if (!parts.length) return null;
  const el = entry("event", "system-prompt", "system", undefined);
  el.dataset.event = "system_prompt";
  const chars = parts.reduce((n, p) => n + p.length, 0);
  expandable(el, toolLine("system prompt", "", `${plural(parts.length, "section")} · ${formatTokens(chars)} chars`), {
    build: () => pre(parts.join("\n\n")),
  });
  return h("section", { class: "session-context" }, el);
}

function renderPrompt(turn: Turn, id: string): HTMLElement | null {
  const u = turn.user;
  if (!u) return null;
  const el = entry("user", id, "you", turn.timestamp);
  const body = el.querySelector(".body")!;
  if (u.command) {
    body.append(h("div", { class: "command" }, h("span", { class: "cmd-name" }, u.command.name), u.command.args ? h("span", { class: "cmd-args" }, ` ${u.command.args}`) : null));
    if (u.expanded) {
      const holder = entry("x", "", "", undefined);
      expandable(holder, toolLine("expanded prompt", firstLine(u.expanded, 100)), { build: () => markdown(u.expanded ?? "") });
      body.append(h("div", { class: "expanded" }, ...Array.from(holder.querySelector(".body")!.childNodes)));
    } else if (u.text && u.text.trim() !== `${u.command.name}${u.command.args ? ` ${u.command.args}` : ""}`.trim()) {
      body.append(markdown(u.text));
    }
  } else body.append(markdown(u.text));
  if (u.images) body.append(h("div", { class: "tnote" }, `${plural(u.images, "image")} omitted`));
  return el;
}

function activitySummary(turn: Turn, list: ResponseUsage[] = []): HTMLElement | null {
  const a = turn.activity;
  const thinking = list.reduce((sum, r) => sum + r.usage.reasoning, 0);
  const output = list.reduce((sum, r) => sum + r.usage.output, 0);
  const parts = [
    a?.toolCalls ? plural(a.toolCalls, "tool call") : "",
    a?.toolErrors ? plural(a.toolErrors, "tool error") : "",
    a?.files.read ? `${plural(a.files.read, "file")} read` : "",
    a?.files.edited ? `${plural(a.files.edited, "file")} edited` : "",
    a?.files.written ? `${plural(a.files.written, "file")} written` : "",
    thinking ? `thinking ${formatTokens(thinking)} tokens` : "",
    output ? `output ${formatTokens(output)} tokens` : "",
  ].filter(Boolean);
  return parts.length ? entry("activity", `turn-${turn.index}-activity`, "work", undefined,
    h("div", { class: "activity-summary", role: "group", "aria-label": "Activity for this turn" }, parts.join(" · "))) : null;
}

/** The subagents a turn launched, on a line of their own: their usage is not part of the turn's model calls above it. */
function subagentFoot(sub: TurnSubagents): HTMLElement {
  return h("div", { class: "foot-sub", title: "Launched in this turn, even if they finished later. Not in the turn's model calls or the session totals." }, turnSubagentsLine(sub));
}

function turnFoot(list: ResponseUsage[] | undefined, sub?: TurnSubagents): HTMLElement | null {
  if (!list?.length) return sub ? h("div", { class: "turn-foot", "aria-label": "Subagent usage for this turn" }, subagentFoot(sub)) : null;
  let out = 0;
  let cost: number | undefined;
  let peak = 0;
  let cached = 0;
  let ctxSum = 0;
  // A turn a fork continued holds inherited and own calls; only the own ones are this session's spend.
  const own = list.filter((r) => !r.inherited);
  const inheritedCalls = list.length - own.length;
  const inherited = own.length === 0;
  for (const r of inherited ? list : own) {
    out += r.usage.output;
    peak = Math.max(peak, contextTokens(r.usage));
    cached += r.usage.cacheRead;
    ctxSum += contextTokens(r.usage);
    if (r.usage.cost !== undefined) cost = (cost ?? 0) + r.usage.cost;
  }
  // Providers that report no cache tokens have no cache figures to show.
  const cacheReported = list.some((r) => r.usage.cacheRead + r.usage.cacheWrite > 0);
  const parts = [
    plural(list.length, "model call"),
    `peak context ${formatTokens(peak)}`,
    `output ${formatTokens(out)}`,
    ctxSum && cacheReported ? `${Math.round((cached / ctxSum) * 100)}% cache hit` : "",
    cost !== undefined && !inherited ? formatCost(cost) : "",
    inherited ? "inherited from parent session" : inheritedCalls ? `${inheritedCalls} inherited` : "",
  ].filter(Boolean);
  // Text as well as colour: a turn with a miss says so.
  const events = [...new Set(list.flatMap((r) => cacheEventOf(r)?.kind ?? []))];
  const kinds = events.map((k) => (k === "miss" ? "cache miss" : k === "rebuild" ? "cache rebuild" : "model switch"));
  return h(
    "div",
    { class: "turn-foot", "aria-label": "Token usage for this turn" },
    h("span", {}, parts.join(" · ")),
    ...kinds.flatMap((k, i) => [" · ", h("span", { class: `foot-cache foot-cache-${events[i]}` }, k)]),
    sub ? subagentFoot(sub) : null,
  );
}

/** A reply's first line without markdown syntax, for the outline. */
export function plainLine(text: string, max = 120): string {
  const line = text.trim().split("\n").find((l) => l.trim() && !/^\s*(```|\|?\s*:?-{3,})/.test(l)) ?? "";
  const plain = line
    .replace(/^\s*(#{1,6}\s+|>\s*|[-*+]\s+|\d+\.\s+)/, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__|`)/g, "")
    .replace(/(^|\W)[*_]([^*_]+)[*_](?=\W|$)/g, "$1$2")
    .replace(/\s+/g, " ");
  return firstLine(plain, max);
}

/** The calls a work step stands for, shell calls named by program: "Bash(git)". */
function callsOf(step: ToolStep | ToolGroupStep): CallCount[] {
  if (step.kind === "toolGroup") return groupCalls(step);
  const input = (step.input ?? {}) as Record<string, unknown>;
  const program = isExecTool(step.name) ? commandName(str(input.command) ?? str(input.cmd) ?? step.summary) : undefined;
  return [{ label: program ? `${step.name}(${program})` : step.name, count: 1, errors: step.isError || step.result?.isError ? 1 : 0 }];
}

/** Consecutive tool calls become one outline item ("Bash(git) ×3 · Edit"). */
function outline(turn: Turn, stepIds: string[]): { items: OutlineItem[]; tools: number; errors: number } {
  const items: OutlineItem[] = [];
  let tools = 0;
  let errors = 0;
  let run: { id: string; ids: string[]; names: Map<string, number>; error: boolean } | undefined;
  const flush = () => {
    if (!run) return;
    const label = [...run.names].map(([n, c]) => (c > 1 ? `${n} ×${c}` : n)).join(" · ");
    items.push({ id: run.id, ids: run.ids, kind: "tools", label, error: run.error });
    run = undefined;
  };
  turn.steps.forEach((step, i) => {
    const id = stepIds[i]!;
    if (step.kind === "tool" || step.kind === "toolGroup") {
      run ??= { id, ids: [], names: new Map(), error: false };
      run.ids.push(id);
      for (const c of callsOf(step)) {
        if (!c.errorsOnly) {
          run.names.set(c.label, (run.names.get(c.label) ?? 0) + c.count);
          tools += c.count;
        }
        errors += c.errors;
        if (c.errors) run.error = true;
      }
      return;
    }
    if (step.kind === "thinking") return;
    flush();
    if (step.kind === "text") items.push({ id, kind: "reply", label: plainLine(step.text) });
    else if (step.kind === "subagent") {
      tools++;
      items.push({ id, kind: "subagent", label: `${step.tool} · ${step.description ?? step.agents.join(", ")}`, error: step.isError });
    } else if (step.kind === "event" && step.event !== "skill" && step.event !== "command") {
      items.push({ id, kind: step.event === "error" || step.event === "interrupted" ? "error" : "event", label: step.text, error: step.event === "error" });
    }
  });
  flush();
  return { items, tools, errors };
}

/**
 * The turn's tool calls, one per call where the steps are individual (full view). Brief
 * groups keep their shell commands, so those are listed one by one; other tools of a group
 * are known only by count, so they stand as one entry that jumps to the group.
 */
function toolCalls(turn: Turn, stepIds: string[], ctx: Ctx): ToolCall[] {
  const out: ToolCall[] = [];
  turn.steps.forEach((step, i) => {
    const id = stepIds[i]!;
    if (step.kind === "tool") {
      const input = (step.input ?? {}) as Record<string, unknown>;
      const program = isExecTool(step.name) ? commandName(str(input.command) ?? str(input.cmd) ?? step.summary) : undefined;
      out.push({ id, tool: step.name, ...(program ? { program } : {}), preview: rel(ctx, step.summary) || step.name, ...(step.isError || step.result?.isError ? { error: true } : {}) });
    } else if (step.kind === "subagent") {
      out.push({ id, tool: step.tool, preview: step.description ?? step.agents.join(", ") ?? step.tool, ...(step.isError ? { error: true } : {}) });
    } else if (step.kind === "toolGroup") {
      const shell = groupShell(step);
      for (const c of step.calls) {
        let rest = c.count;
        if (c === shell?.call) {
          for (const command of shell.commands) {
            const program = commandName(command);
            out.push({ id, tool: c.name, ...(program ? { program } : {}), preview: rel(ctx, command) });
          }
          rest -= shell.commands.length;
        }
        if (rest > 0) out.push({ id, tool: c.name, preview: c === shell?.call ? "command not kept" : "details not kept in this view", count: rest, ...(c.errors ? { error: true } : {}) });
      }
    }
  });
  return out;
}

/** The first step of each model call in a turn, by call id (a call's steps come together, so the first is where it starts). */
function responseSteps(turn: Turn, stepIds: string[]): Map<string, string> {
  const out = new Map<string, string>();
  turn.steps.forEach((s, i) => {
    for (const id of s.kind === "toolGroup" ? s.responseIds : s.responseId ? [s.responseId] : []) if (!out.has(id)) out.set(id, stepIds[i]!);
  });
  return out;
}

export function responsesByTurn(session: NormalizedSession): Map<number, ResponseUsage[]> {
  const byTurn = new Map<number, ResponseUsage[]>();
  for (const r of session.responses) {
    const list = byTurn.get(r.turn) ?? [];
    list.push(r);
    byTurn.set(r.turn, list);
  }
  return byTurn;
}

export function renderTranscript(session: NormalizedSession, opts: TranscriptOptions = {}): { el: HTMLElement; turns: TurnInfo[] } {
  const ctx: Ctx = { ...opts, cwd: session.project?.cwd, byTurn: responsesByTurn(session) };
  const turns: TurnInfo[] = [];
  let ordinal = 0;
  const build = (turn: Turn): HTMLElement => {
      const n = turn.user ? ++ordinal : 0;
      const id = `turn-${turn.index}`;
      // Only Claude Code's usage is read from the subagents' own transcripts; pi's chip is best effort and covers some launches only, so it is not summed.
      const subagents = metaOf(session.harness.name)?.sumsSubagentUsage ? turnSubagents(turn) : undefined;
      const stepIds = turn.steps.map((_, i) => stepId(turn.index, i));
      const section = h(
        "section",
        { class: `turn${turn.user ? "" : " turn-start"}`, id, "data-turn": String(turn.index), "data-n": String(n) },
        h("div", { class: "turn-head", "aria-hidden": "true" }, h("span", { class: "turn-n" }, n ? String(n) : "·"), turn.timestamp ? h("time", {}, clock(turn.timestamp)) : null),
        renderPrompt(turn, promptId(turn.index)),
        ...(session.mode === "prompts" ? [activitySummary(turn, ctx.byTurn.get(turn.index))] : turn.steps.map((s, i) => renderStepSafe(s, stepIds[i]!, ctx))),
        session.mode === "prompts" ? null : turnFoot(ctx.byTurn.get(turn.index), subagents),
      );
      const o = outline(turn, stepIds);
      const u = turn.user;
      turns.push({
        index: turn.index,
        ordinal: n,
        id,
        el: section,
        // Capped like a prompt: a command's arguments can be a whole pasted document.
        label: u ? (u.command ? firstLine(`${u.command.name}${u.command.args ? ` ${u.command.args}` : ""}`.replace(/\s+/g, " "), 140) : plainLine(u.text.replace(/\s+/g, " "), 140)) : "Session start",
        time: clock(turn.timestamp),
        command: Boolean(u?.command),
        tools: session.mode === "prompts" ? turn.activity?.toolCalls ?? 0 : o.tools,
        errors: session.mode === "prompts" ? turn.activity?.toolErrors ?? 0 : o.errors,
        items: o.items,
        calls: toolCalls(turn, stepIds, ctx),
        responses: ctx.byTurn.get(turn.index) ?? [],
        ...(subagents ? { subagents } : {}),
        responseSteps: session.mode === "prompts" ? new Map() : responseSteps(turn, stepIds),
      });
      return section;
  };
  // The last resort for a turn the passes above can't make sense of: a placeholder keeps the rest of the session readable.
  const failed = (turn: Turn): HTMLElement => {
    const n = turn.user ? ordinal : 0;
    const id = `turn-${turn.index}`;
    const section = h("section", { class: "turn", id, "data-turn": String(turn.index), "data-n": String(n) }, unsupported(stepId(turn.index, 0), "turn", undefined, true));
    turns.push({ index: turn.index, ordinal: n, id, el: section, label: n ? `Prompt ${n}` : "Session start", tools: 0, errors: 0, items: [], calls: [], responses: [], responseSteps: new Map() });
    return section;
  };
  const sections = session.turns
    .filter((t) => t.user || t.steps.length || (session.mode === "prompts" && (t.activity?.toolCalls || ctx.byTurn.has(t.index))))
    .map((turn) => {
      const before = turns.length;
      try {
        return build(turn);
      } catch {
        turns.length = before;
        return failed(turn);
      }
    });
  return { el: h("div", { class: "transcript" }, session.mode === "full" ? renderSystemPrompt(session.systemPrompt) : null, ...sections), turns };
}
