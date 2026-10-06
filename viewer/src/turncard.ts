/**
 * The cards the token charts' bars open (chartcard.ts holds the shared pieces):
 *
 * - a context-by-turn bar, for one turn or several merged into it: views ledger, table,
 *   waterfall and bar;
 * - a bar of the in-view turn's chart for one model call: its prompt, where that prompt's new
 *   tokens came from and what the call added to the next one (no views);
 * - a bar of that chart merging several calls: views ledger, table, waterfall and calls.
 *
 * Views are picked from tabs at a card's top. The pick holds for every card that has that view
 * until the page is reloaded; a card without it opens in ledger.
 *
 * Sources: your prompt, then each model call. The API reports new prompt tokens (cache write
 * and uncached input) on the call whose prompt carried them; the table, waterfall, bar and the
 * call card credit them one step back, to what produced them: the first call's to your prompt
 * (and the previous turn's last reply, which can't be told apart from it), each later call's to
 * the call before it (its output and tool results). The last call's reply lands in the next
 * turn's first prompt. Calls outside the conversation (a compaction, a background call) have
 * prompts of their own and are left out of the sources.
 */
import { cacheEventDetail, cacheEventLabel, formatCost, formatTokens, plural } from "../../src/format.ts";
import { contextTokens, type CacheEvent, type ResponsePurpose, type ResponseUsage, type Step } from "../../src/schema.ts";
import { cacheNotes, cardHead, cardRow, contextBlock, floatingMore, note, outputBlock, SEGMENTS, stepActivity, type Activity } from "./chartcard.ts";
import { h, withTooltip } from "./dom.ts";
import { infoIcon } from "./el.ts";
import { turnSubagentsLine } from "./subagents.ts";
import type { TurnInfo } from "./transcript.ts";
import { cacheEventOf } from "./usageinfo.ts";

export type CardView = "ledger" | "table" | "waterfall" | "bar" | "calls";

interface ViewInfo {
  shows: string;
  answers: string;
  shifted: boolean;
}
const TABLE: ViewInfo = {
  shows: "A row per source of new tokens: your prompt, then each model call. Columns: the context after it, the cache write and uncached input it added, and the call's own output, each on its own scale. Tool calls a model call made at once share its row and are listed under it.",
  answers: "Which step grew the context, and by how much?",
  shifted: true,
};
/** The views of a context-by-turn bar's card. */
const TURN_VIEWS: Partial<Record<CardView, ViewInfo>> = {
  ledger: {
    shows: "Each turn's largest prompt split into cache read, cache write and uncached input, then its output, and a line per model call with the size of that call's prompt.",
    answers: "How big did the context get, and how much of it came from cache?",
    shifted: false,
  },
  table: TABLE,
  waterfall: {
    shows: "The turn's new tokens as one bar, with the cache read it started from cut short. Below, a row per source; each row's piece sits under the part of the bar it added. Each turn has its own scale.",
    answers: "Where did this turn's growth come from?",
    shifted: true,
  },
  bar: {
    shows: "A bar per turn: the cache read it started from cut short, then its new tokens split by source, named where there is room. Every source is a chip below. Turns share one scale.",
    answers: "Which turns grew the most, and from what?",
    shifted: true,
  },
};
/** The views of a card for a bar merging a turn's model calls. */
const CALL_VIEWS: Partial<Record<CardView, ViewInfo>> = {
  ledger: {
    shows: "A section per model call: its prompt split into cache read, cache write and uncached input, its output, and the steps it produced.",
    answers: "How big was each call's prompt, and how much of it came from cache?",
    shifted: false,
  },
  table: TABLE,
  waterfall: {
    shows: "These calls' new tokens as one bar, with the cache read they started from cut short. Below, a row per source; each row's piece sits under the part of the bar it added.",
    answers: "Which of these calls grew the context?",
    shifted: true,
  },
  calls: {
    shows: "A bar per call: its prompt's cache read cut short, then the cache write and uncached input it carried, on one scale. As reported, not credited back to the step before.",
    answers: "Which prompts carried the most new tokens?",
    shifted: false,
  },
};
const SHIFTED =
  "The API reports new tokens on the call whose prompt carried them. Here a call is credited with what its output and tool results added to the next prompt, and the first row is your prompt (with the previous turn's last reply). The last call's reply counts in the next turn (→). Totals are unchanged.";
const SHIFTED_FOOT = "+N: what a step added to the next prompt · →: counts in the next turn";

/** The view cards open in; kept until the page is reloaded. */
let lastView: CardView = "ledger";

export function setCardView(v: CardView): void {
  lastView = v;
}

/** Where the card's lines lead, and what it needs to name the steps a call produced. */
export interface TurnCardEnv {
  /** The steps each model call produced, by call id. */
  produced: Map<string, Step[]>;
  /** Each step's DOM id. */
  stepIds: Map<Step, string>;
  cwd?: string;
  onJump: (turn: number) => void;
  onJumpTo?: (id: string) => void;
}

/** Lines listed per member when several share the card; the rest are counted. */
const MERGED_LINES = 5;
/** Share of a bar the cut cache read keeps (a waterfall's track is narrower, so less). */
const STUB = 15;
const WF_STUB = 10;
/** A source wider than this share of the bar is named inside it. */
const LABEL_SHARE = 0.2;
const NOT_TOOLS = new Set(["reply", "thinking", "event"]);

const PURPOSE_LABEL: Record<ResponsePurpose, string> = {
  compaction: "compaction",
  summary: "branch summary",
  tool: "made by a tool",
  "cache-warm": "cache keep-alive",
  background: "background call",
};

interface Line extends Activity {
  go?: () => void;
  /** Other steps of the same call, besides the one named. */
  extra?: number;
  you?: true;
}

interface Call {
  r: ResponseUsage;
  /** 1-based, among the turn's calls. */
  n: number;
  line: Line;
  /** Every step it produced, each going to its own step. */
  acts: Line[];
  /** Tool calls it made at once, listed under its row. */
  batch: Line[];
}

interface Source {
  /** Ties a row or chip to its piece of the bar. */
  key: string;
  line: Line;
  batch: Line[];
  /** The model call it is (none: your prompt). */
  from?: Call;
  /** The call whose prompt carried what this added; none for the last call. */
  into?: ResponseUsage;
  /** A model call's own output. */
  output?: number;
}

interface Model {
  t: TurnInfo;
  name: string;
  cost?: number;
  inherited: boolean;
  fromParent: number;
  peak: ResponseUsage;
  output: number;
  reasoning: number;
  calls: Call[];
  carried: number;
  end: number;
  write: number;
  input: number;
  added: number;
  sources: Source[];
  events: CacheEvent[];
}

/** Every step a model call produced, each going to its own step; and the call as one line ("Read ×3 a · b · c" for a batch). */
function callOf(r: ResponseUsage, n: number, t: TurnInfo, env: TurnCardEnv): Call {
  const acts: Line[] = (env.produced.get(r.id) ?? []).flatMap((s) => {
    const id = env.stepIds.get(s);
    return stepActivity([s], env.cwd).map((a) => ({ ...a, ...(id && env.onJumpTo ? { go: () => env.onJumpTo!(id) } : {}) }));
  });
  const first = env.onJumpTo ? t.responseSteps.get(r.id) : undefined;
  const callGo = first ? { go: () => env.onJumpTo!(first) } : {};
  const error = acts.some((a) => a.error) ? { error: true } : {};
  const tools = acts.filter((a) => !NOT_TOOLS.has(a.what));
  if (tools.length > 1) {
    const one = new Set(tools.map((a) => a.what)).size === 1;
    const line = { what: one ? `${tools[0]!.what} ×${tools.length}` : `${tools.length} tools`, text: tools.map((a) => a.text).join(" · "), ...error, ...callGo };
    return { r, n, acts, line: acts.length > tools.length ? { ...line, extra: acts.length - tools.length } : line, batch: tools };
  }
  // A tool names the line over the reply or thinking around it: its result is what the next prompt carries.
  const main = tools[0] ?? acts.find((a) => a.what !== "thinking") ?? acts[0];
  const line: Line = main ? { ...callGo, ...main, ...error, ...(acts.length > 1 ? { extra: acts.length - 1 } : {}) } : { what: "call", text: "", ...callGo };
  return { r, n, acts, line, batch: [] };
}

const added = (r: ResponseUsage): number => r.usage.cacheWrite + r.usage.input;

/** A model whose sources are `sources`, with the figures they add up to. */
function withSources(base: Omit<Model, "carried" | "end" | "write" | "input" | "added" | "sources">, sources: Source[]): Model {
  const into = sources.flatMap((s) => (s.into ? [s.into] : []));
  const write = into.reduce((n, r) => n + r.usage.cacheWrite, 0);
  const input = into.reduce((n, r) => n + r.usage.input, 0);
  const first = sources[0];
  const carried = first?.into ? first.into.usage.cacheRead : first?.from ? contextTokens(first.from.r.usage) : 0;
  return { ...base, sources, write, input, added: write + input, carried, end: into.length ? contextTokens(into[into.length - 1]!.usage) : carried };
}

function model(t: TurnInfo, env: TurnCardEnv): Model {
  const own = t.responses.filter((r) => !r.inherited);
  const costs = own.flatMap((r) => (r.usage.cost !== undefined ? [r.usage.cost] : []));
  const calls = t.responses.map((r, i) => callOf(r, i + 1, t, env));
  const chain = calls.filter((c) => !c.r.purpose);
  const sources: Source[] = chain.length
    ? [
        { key: `${t.index}-p`, line: { what: "you", text: t.label, you: true, go: () => env.onJump(t.index) }, batch: [], into: chain[0]!.r },
        ...chain.map((c, k) => ({ key: `${t.index}-${k}`, line: c.line, batch: c.batch, from: c, into: chain[k + 1]?.r, output: c.r.usage.output })),
      ]
    : [];
  return withSources(
    {
      t,
      name: t.ordinal ? `Turn ${t.ordinal}` : "Start",
      ...(costs.length ? { cost: costs.reduce((a, b) => a + b, 0) } : {}),
      inherited: own.length === 0,
      fromParent: t.responses.length - own.length,
      peak: t.responses.reduce((a, b) => (contextTokens(b.usage) > contextTokens(a.usage) ? b : a)),
      output: t.responses.reduce((n, r) => n + r.usage.output, 0),
      reasoning: t.responses.reduce((n, r) => n + r.usage.reasoning, 0),
      calls,
      events: t.responses.flatMap((r) => cacheEventOf(r) ?? []),
    },
    sources,
  );
}

/** The turn narrowed to the calls `ids` (a bar of its chart): their sources, and your prompt if the first of them is the turn's first. */
function narrow(m: Model, ids: Set<string>): Model {
  const calls = m.calls.filter((c) => ids.has(c.r.id));
  const sources = m.sources.filter((s) => (s.from ? ids.has(s.from.r.id) : Boolean(s.into && ids.has(s.into.id))));
  const own = calls.filter((c) => !c.r.inherited);
  const costs = own.flatMap((c) => (c.r.usage.cost !== undefined ? [c.r.usage.cost] : []));
  return withSources(
    {
      ...m,
      name: `Calls ${calls[0]!.n}–${calls[calls.length - 1]!.n}`,
      ...(costs.length ? { cost: costs.reduce((a, b) => a + b, 0) } : { cost: undefined }),
      inherited: own.length === 0,
      fromParent: calls.length - own.length,
      peak: calls.reduce((a, b) => (contextTokens(b.r.usage) > contextTokens(a.r.usage) ? b : a)).r,
      output: calls.reduce((n, c) => n + c.r.usage.output, 0),
      reasoning: calls.reduce((n, c) => n + c.r.usage.reasoning, 0),
      calls,
      events: calls.flatMap((c) => cacheEventOf(c.r) ?? []),
    },
    sources,
  );
}

/** For each conversation call, the one whose prompt carries its output and results (the chart lights it up). */
export function nextCalls(responses: ResponseUsage[]): Map<string, ResponseUsage> {
  const chain = responses.filter((r) => !r.purpose);
  return new Map(chain.flatMap((r, k) => (chain[k + 1] ? [[r.id, chain[k + 1]!] as const] : [])));
}

const share = (v: number, total: number): string => (!v || !total ? "" : (v / total) * 100 < 1 ? "<1%" : `${Math.round((v / total) * 100)}%`);

/** A call's new prompt tokens by kind; the share a cache event re-processed is hatched. */
function addedParts(r: ResponseUsage): [cls: string, v: number][] {
  const u = r.usage;
  const re = Math.min(cacheEventOf(r)?.recached ?? 0, u.cacheWrite + u.input);
  const fromWrite = Math.min(re, u.cacheWrite);
  return [
    ["seg-recached", re],
    ["seg-cache-write", u.cacheWrite - fromWrite],
    ["seg-input", u.input - (re - fromWrite)],
  ];
}

function segs(parts: [string, number][]): HTMLElement[] {
  return parts.flatMap(([cls, v]) => {
    if (v <= 0) return [];
    const seg = h("span", { class: `seg ${cls}` });
    seg.style.flexGrow = String(v);
    return [seg];
  });
}

/** The cache read a prompt started from, cut short behind a break mark, taking `width`% of the bar. */
function stub(carried: number, withText: boolean, width = STUB): HTMLElement {
  // Nothing cached yet (a session's first prompt, or after a miss): an empty outline, not a blue block.
  const el = h("span", { class: `tc-stub${carried ? "" : " is-empty"}` }, h("span", { class: "tc-stub-read", title: `${formatTokens(carried)} cache read carried in` }, withText ? formatTokens(carried) : ""), h("span", { class: "tc-cut" }));
  el.style.width = `${width}%`;
  return el;
}

/** One piece per source in a bar, each tied to its row or chip. */
function groups(m: Model, label?: (s: Source, v: number) => string | null): HTMLElement[] {
  return m.sources.flatMap((s) => {
    const v = s.into ? added(s.into) : 0;
    if (!s.into || v <= 0) return [];
    const text = label?.(s, v);
    const g = h("span", { class: "tc-grp", "data-src": s.key }, ...segs(addedParts(s.into)), text ? h("span", { class: "tc-lbl" }, text) : null);
    g.style.flexGrow = String(v);
    return [g];
  });
}

type Pick = (go?: () => void) => (() => void) | undefined;

/** A row or line: a button when it leads somewhere. */
function pickable(go: (() => void) | undefined, cls: string, attrs: Record<string, string>, ...children: (Node | string | null)[]): HTMLElement {
  return go ? h("button", { type: "button", class: cls, "data-hc-item": "", onclick: go, ...attrs }, ...children) : h("div", { class: `${cls} is-static`, ...attrs }, ...children);
}

function lineEl(l: Line, left: string | null, pick: Pick, o: { hot?: boolean; src?: string; title?: string } = {}): HTMLElement {
  return pickable(
    pick(l.go),
    `hc-item cb-line${l.error ? " is-error" : ""}`,
    { title: o.title ?? l.text, ...(o.src ? { "data-src": o.src } : {}) },
    left === null ? null : h("span", { class: `cb-ctx${o.hot ? " hot" : ""}` }, left),
    h("span", { class: `cb-what${l.you ? " tc-you" : ""}` }, l.what),
    h("span", { class: "hc-text" }, l.text || "–"),
    l.extra ? h("span", { class: "hc-n" }, `+${l.extra}`) : null,
  );
}

const more = (n: number, word: string): HTMLElement | null => (n > 0 ? h("p", { class: "cc-more cb-more" }, `+${plural(n, `more ${word}`)}`) : null);

/** The turn's heading: its name and cost when several turns share the card, and its prompt; it goes to the turn. */
function head(m: Model, named: boolean, pick: Pick, onJump: (turn: number) => void): HTMLElement {
  return pickable(
    pick(() => onJump(m.t.index)),
    "cb-head",
    { title: m.t.label },
    named ? h("span", { class: "cb-titles" }, h("span", { class: "cb-name" }, m.name), m.cost !== undefined && !m.inherited ? h("span", { class: "cb-cost" }, formatCost(m.cost)) : null) : null,
    h("span", { class: "cb-label" }, m.t.ordinal ? `“${m.t.label}”` : m.t.label),
  );
}

/** Calls, tools, and what the figures leave out. */
function facts(m: Model, ...lead: string[]): HTMLElement[] {
  const t = m.t;
  const line = [...lead, plural(t.responses.length, "call"), ...(t.tools ? [`${plural(t.tools, "tool")}${t.errors ? ` (${t.errors} failed)` : ""}`] : [])].join(" · ");
  const notes = [
    m.inherited ? "Inherited from the parent session (not counted)" : m.fromParent ? `${plural(m.fromParent, "call")} from parent (cost not counted)` : null,
    t.subagents ? `Launched ${turnSubagentsLine(t.subagents)}, not in these figures` : null,
  ];
  return [h("div", { class: "cb-facts tc-pad" }, line), ...notes.flatMap((n) => (n ? [h("p", { class: "cc-muted tc-pad" }, n)] : []))];
}

function cacheLines(events: CacheEvent[], max = 2): HTMLElement[] {
  return [...events.slice(0, max).map((e) => note(e.kind, `${cacheEventLabel(e)}: ${cacheEventDetail(e)}`)), ...(events.length > max ? [h("p", { class: "cc-more" }, `+${events.length - max} more cache events`)] : [])].map((el) => {
    el.classList.add("tc-pad");
    return el;
  });
}

const sourceTitle = (s: Source): string =>
  s.line.you ? "Your prompt, with the previous turn's last reply" : s.into ? `${s.line.text}\nIts output and results added ${formatTokens(added(s.into))} to the next prompt` : `${s.line.text}\nIts reply goes into the next turn`;

/** What a view draws: whole turns (a context-by-turn bar), or a run of one turn's calls. */
interface Ctx {
  models: Model[];
  merged: boolean;
  /** A run of calls, inside the turn the rail shows: no turn headings or turn figures. */
  run: boolean;
  pick: Pick;
  env: TurnCardEnv;
}

/** A prompt split into cache read, cache write and uncached input, drawn against `top`. */
function splitBar(u: ResponseUsage["usage"], top: number): HTMLElement {
  const ctx = contextTokens(u);
  const bar = h("div", { class: "cc-bar cb-bar", "aria-hidden": "true" }, ...segs(SEGMENTS.map(([k, cls]) => [cls, u[k] ?? 0])));
  bar.style.width = `${Math.max(2, (ctx / top) * 100)}%`;
  return bar;
}

// ---------- ledger ----------
function ledger({ models, merged, pick, env }: Ctx): HTMLElement[] {
  const top = Math.max(1, ...models.map((m) => contextTokens(m.peak.usage)));
  return models.map((m) => {
    const u = m.peak.usage;
    const ctx = contextTokens(u);
    const max = merged ? MERGED_LINES : Infinity;
    return h(
      "section",
      { class: `cb-entry tc-unit${m.inherited ? " is-inh" : ""}` },
      head(m, merged, pick, env.onJump),
      h(
        "div",
        { class: "tc-pad tc-ledger" },
        h("div", { class: "cc-total" }, h("span", {}, m.t.responses.length > 1 ? "peak context" : "context"), h("span", { class: "cc-v" }, formatTokens(ctx))),
        ctx ? splitBar(u, top) : null,
        ...SEGMENTS.map(([k, cls, name]) => cardRow(name, formatTokens(u[k] ?? 0), { swatch: cls, extra: share(u[k] ?? 0, ctx), muted: !u[k] })),
        cardRow("output", formatTokens(m.output), { swatch: "seg-output", note: m.reasoning ? `(${formatTokens(m.reasoning)} thinking)` : undefined }),
      ),
      ...facts(m),
      ...cacheLines(m.events),
      h("div", { class: "cb-lines" }, ...m.calls.slice(0, max).map((c) => lineEl(c.line, formatTokens(contextTokens(c.r.usage)), pick))),
      more(m.calls.length - max, "call"),
    );
  });
}

/** A run's ledger: a section per call, its prompt split and what it produced. */
function callLedger({ models, pick }: Ctx): HTMLElement[] {
  const m = models[0]!;
  const top = Math.max(1, ...m.calls.map((c) => contextTokens(c.r.usage)));
  return m.calls.map((c) => {
    const u = c.r.usage;
    const split = SEGMENTS.map(([k, , name]) => `${formatTokens(u[k] ?? 0)} ${name.replace("uncached ", "")}`);
    return h(
      "section",
      { class: `cb-entry tc-unit${c.r.inherited ? " is-inh" : ""}` },
      pickable(
        pick(c.line.go),
        "cb-head",
        {},
        h("span", { class: "cb-titles" }, h("span", { class: "cb-name" }, `Call ${c.n}`), !c.r.inherited && u.cost !== undefined ? h("span", { class: "cb-cost" }, formatCost(u.cost)) : null),
        c.r.purpose ? h("span", { class: "cb-label" }, PURPOSE_LABEL[c.r.purpose]) : null,
      ),
      h("div", { class: "tc-pad" }, splitBar(u, top), h("div", { class: "cb-facts" }, [...split, `${formatTokens(u.output)} out`].join(" · "))),
      ...cacheLines(cacheEventOf(c.r) ? [cacheEventOf(c.r)!] : []),
      h("div", { class: "cb-lines" }, ...c.acts.slice(0, 3).map((a) => lineEl(a, null, pick))),
      more(c.acts.length - 3, "step"),
    );
  });
}

// ---------- table ----------
interface Scale {
  ctx: number;
  write: number;
  input: number;
  out: number;
}
const scaleOf = (rows: Scale[]): Scale => ({
  ctx: Math.max(1, ...rows.map((r) => r.ctx)),
  write: Math.max(1, ...rows.map((r) => r.write)),
  input: Math.max(1, ...rows.map((r) => r.input)),
  out: Math.max(1, ...rows.map((r) => r.out)),
});

function num(v: number | undefined, max: number, cls: string, plus = false): HTMLElement {
  if (v === undefined) return h("span", { class: "tc-num" });
  const tick = h("span", { class: `tc-tick ${cls}` });
  tick.style.width = v ? `${Math.max(4, (v / max) * 100)}%` : "0";
  return h("span", { class: "tc-num" }, v ? `${plus ? "+" : ""}${formatTokens(v)}` : h("span", { class: "tc-z" }, "–"), h("span", { class: "tc-ticks" }, tick));
}

function table({ models, merged, run, pick, env }: Ctx): HTMLElement[] {
  const into = (s: Source) => (s.into ? { ctx: contextTokens(s.into.usage), write: s.into.usage.cacheWrite, input: s.into.usage.input } : undefined);
  const sc = scaleOf(models.flatMap((m) => m.sources.map((s) => ({ ...(into(s) ?? { ctx: 0, write: 0, input: 0 }), out: s.output ?? 0 }))));
  const turnScale = scaleOf(models.map((m) => ({ ctx: m.end, write: m.write, input: m.input, out: m.output })));
  const row = (go: (() => void) | undefined, cls: string, label: (Node | string)[], cells: HTMLElement[], attrs: Record<string, string> = {}) =>
    pickable(go, `tc-row ${cls}`, attrs, h("span", { class: "tc-lab" }, ...label), ...cells);
  const max = merged ? MERGED_LINES - 1 : Infinity;
  const body = models.flatMap((m) => {
    const turnRow = merged
      ? [row(pick(() => env.onJump(m.t.index)), "tc-turnrow tc-unit", [h("b", {}, m.name), m.cost !== undefined && !m.inherited ? ` ${formatCost(m.cost)}` : ""], [num(m.end, turnScale.ctx, "seg-cache-read"), num(m.write, turnScale.write, "seg-cache-write", true), num(m.input, turnScale.input, "seg-input", true), num(m.output, turnScale.out, "seg-output")], { title: m.t.label })]
      : [];
    if (!m.sources.length) return [...turnRow, h("p", { class: "cc-muted tc-pad" }, "No conversation calls here.")];
    const shown = m.sources.slice(0, max + 1);
    const lines = shown.flatMap((s) => {
      const v = into(s);
      const re = s.into ? addedParts(s.into)[0]![1] : 0;
      const cells = [
        v ? num(v.ctx, sc.ctx, "seg-cache-read") : h("span", { class: "tc-num" }, h("span", { class: "tc-z", title: "Its reply goes into the next turn" }, "→")),
        num(v?.write, sc.write, re ? "seg-recached" : "seg-cache-write", true),
        num(v?.input, sc.input, "seg-input", true),
        num(s.output, sc.out, "seg-output"),
      ];
      const label = [h("i", { class: s.line.you ? "tc-you" : "" }, s.line.what), " ", s.batch.length ? `${s.batch.length} at once` : s.line.text || "–"];
      return [
        row(pick(s.line.go), `${s.line.you ? "tc-yourow" : "tc-callrow"}${run ? " tc-unit" : ""}${s.line.error ? " is-error" : ""}`, label, cells, { title: sourceTitle(s) }),
        ...s.batch.map((b) => row(pick(b.go), `tc-subrow${b.error ? " is-error" : ""}`, [`${b.what} ${b.text}`], [], { title: b.text })),
      ];
    });
    return [...turnRow, ...lines, ...(m.sources.length > shown.length ? [more(m.sources.length - shown.length, "call")!] : [])];
  });
  const total = merged
    ? []
    : models.map((m) => h("div", { class: "tc-row tc-sum" }, h("span", { class: "tc-lab" }, run ? "these calls" : "turn"), num(m.end, sc.ctx, ""), num(m.write, sc.write, "", true), num(m.input, sc.input, "", true), num(m.output, sc.out, "")));
  const th = (text: string, title?: string) => h("span", { class: "tc-th", ...(title ? { title } : {}) }, text);
  return [
    h(
      "div",
      { class: "tc-table" },
      h("div", { class: "tc-row tc-headrow", "aria-hidden": "true" }, th(merged ? "turn · step" : "step"), th("ctx →", "Context after the step's tokens were added"), th("+write"), th("+input"), th("out")),
      ...body,
      ...total,
    ),
  ];
}

// ---------- waterfall ----------
function waterfall({ models, merged, run, pick, env }: Ctx): HTMLElement[] {
  return models.map((m) => {
    const max = merged ? MERGED_LINES + 1 : Infinity;
    const rows = m.sources.slice(0, max);
    let off = 0;
    const scale = Math.max(1, m.added);
    const rowEls = rows.map((s) => {
      const v = s.into ? added(s.into) : 0;
      const piece = !s.into ? h("span", { class: "tc-end", title: "Its reply goes into the next turn" }, "→") : v > 0 ? h("span", { class: "tc-piece" }, ...segs(addedParts(s.into))) : null;
      if (piece && s.into) {
        piece.style.left = `${(off / scale) * 100}%`;
        piece.style.width = `${Math.max(1.5, (v / scale) * 100)}%`;
      }
      off += v;
      const el = lineEl(s.line, s.into ? `+${formatTokens(v)}` : "→", pick, { hot: v > m.added / 3, src: s.key, title: sourceTitle(s) });
      el.classList.add("tc-wf-row");
      if (run) el.classList.add("tc-unit");
      el.append(h("span", { class: "tc-wf-track" }, stub(m.carried, false, WF_STUB), h("span", { class: "tc-new" }, piece)));
      return el;
    });
    const top = h(
      "div",
      { class: "tc-wf-top" },
      h("span", { class: "tc-wf-total" }, h("span", {}, `${formatTokens(m.carried)} → ${formatTokens(m.end)}`), h("b", {}, `+${formatTokens(m.added)}`)),
      h("span", { class: "tc-wf-track" }, stub(m.carried, false, WF_STUB), h("span", { class: "tc-new tc-srcbar" }, ...groups(m))),
    );
    return h(
      "section",
      { class: `cb-entry${run ? "" : " tc-unit"}${m.inherited ? " is-inh" : ""}` },
      !run && (merged || m.t.ordinal) ? head(m, merged, pick, env.onJump) : null,
      m.sources.length ? h("div", { class: "tc-lit tc-wf" }, top, ...rowEls) : h("p", { class: "cc-muted tc-pad" }, "No conversation calls here."),
      more(m.sources.length - rows.length, "call"),
      ...(run ? [] : [...facts(m, `${formatTokens(m.output)} out`), ...cacheLines(m.events)]),
    );
  });
}

// ---------- bar ----------
function bars({ models, merged, pick, env }: Ctx): HTMLElement[] {
  const scale = Math.max(1, ...models.map((m) => m.added));
  return models.map((m) => {
    const width = (m.added / scale) * (100 - STUB);
    const src = h(
      "span",
      { class: "tc-srcbar" },
      ...groups(m, (s, v) => ((v / scale) * ((100 - STUB) / 100) >= LABEL_SHARE ? `${s.line.what} +${formatTokens(v)}` : null)),
    );
    src.style.width = `${Math.max(2, width)}%`;
    const chips = m.sources.map((s) => {
      if (!s.into) return h("span", { class: "tc-chip is-end", title: "Its reply goes into the next turn" }, h("i", {}, s.line.what), "→");
      const v = added(s.into);
      return pickable(
        pick(s.line.go),
        `tc-chip${s.line.you ? " is-you" : ""}${s.line.error ? " is-error" : ""}`,
        { "data-src": s.key, title: sourceTitle(s) },
        h("i", {}, s.line.what),
        v > m.added / 3 ? h("b", {}, `+${formatTokens(v)}`) : `+${formatTokens(v)}`,
      );
    });
    return h(
      "section",
      { class: `cb-entry tc-unit${m.inherited ? " is-inh" : ""}` },
      merged || m.t.ordinal ? head(m, merged, pick, env.onJump) : null,
      m.sources.length
        ? h(
            "div",
            { class: "tc-lit tc-pad" },
            h("div", { class: "tc-caption" }, h("span", {}, `${formatTokens(m.carried)} → ${formatTokens(m.end)} context`), h("span", {}, `+${formatTokens(m.added)} this turn`)),
            h("div", { class: "tc-lb", "aria-hidden": "true" }, stub(m.carried, true), src),
            h("div", { class: "tc-chips" }, ...chips),
          )
        : h("p", { class: "cc-muted tc-pad" }, "No conversation calls here."),
      ...facts(m, `${formatTokens(m.output)} out`),
      ...cacheLines(m.events),
    );
  });
}

// ---------- calls: each prompt's new tokens, as reported ----------
function perCall({ models, pick }: Ctx): HTMLElement[] {
  const m = models[0]!;
  const scale = Math.max(1, ...m.calls.map((c) => added(c.r)));
  const rows = m.calls.map((c) => {
    const v = added(c.r);
    const fill = h("span", { class: "tc-srcbar" }, ...segs(addedParts(c.r)));
    fill.style.width = `${v ? Math.max(1.5, (v / scale) * (100 - STUB)) : 0}%`;
    const el = lineEl(c.line, `+${formatTokens(v)}`, pick, { hot: v > scale / 2, title: `Call ${c.n}: ${c.line.text}\nIts prompt: ${formatTokens(c.r.usage.cacheRead)} cache read, +${formatTokens(v)} new` });
    el.classList.add("tc-wf-row", "tc-unit");
    el.append(h("span", { class: "tc-wf-track" }, stub(c.r.usage.cacheRead, false), fill));
    return el;
  });
  return [h("div", { class: "tc-wf tc-calls" }, ...rows)];
}

type Render = (c: Ctx) => HTMLElement[];
const TURN_RENDER: Partial<Record<CardView, Render>> = { ledger, table, waterfall, bar: bars };
const CALL_RENDER: Partial<Record<CardView, Render>> = { ledger: callLedger, table, waterfall, calls: perCall };

/** Hovering (or focusing) a row or chip lights up its piece of the bar, and the reverse. */
function lightSources(list: HTMLElement): void {
  let lit: HTMLElement | undefined;
  const light = (target: EventTarget | null) => {
    const el = target instanceof Element ? target.closest<HTMLElement>("[data-src]") : null;
    const scope = el?.closest<HTMLElement>(".tc-lit") ?? undefined;
    if (lit && lit !== scope) {
      lit.classList.remove("is-lit");
      for (const x of lit.querySelectorAll(".lit")) x.classList.remove("lit");
    }
    lit = scope;
    if (!scope || !el) return;
    scope.classList.add("is-lit");
    for (const x of scope.querySelectorAll<HTMLElement>("[data-src]")) x.classList.toggle("lit", x.dataset.src === el.dataset.src);
  };
  list.addEventListener("pointerover", (e) => light(e.target));
  list.addEventListener("pointerleave", () => light(null));
  list.addEventListener("focusin", (e) => light(e.target));
  list.addEventListener("focusout", () => light(null));
}

/** The card grew or shrank with its view: keep it inside the window. */
function keepInView(el: HTMLElement): void {
  const card = el.closest<HTMLElement>(".hcard");
  if (!card) return;
  const r = card.getBoundingClientRect();
  if (r.bottom > window.innerHeight - 8) card.style.top = `${Math.max(8, window.innerHeight - 8 - r.height)}px`;
}

interface ShellOptions {
  title: string;
  aside: string;
  views: Partial<Record<CardView, ViewInfo>>;
  render: Partial<Record<CardView, Render>>;
  ctx: Ctx;
  overview: (HTMLElement | null)[];
  /** What the floating pill counts ("turn", "call"); its members are marked .tc-unit. */
  unit: string;
}

/** A card with a tab per view, an explanation of the one shown, and a list that scrolls. */
function viewCard(o: ShellOptions): HTMLElement {
  const order = Object.keys(o.views) as CardView[];
  let view = o.views[lastView] ? lastView : "ledger";
  const list = h("div", { class: "hc-list tc-list" });
  const foot = h("div", { class: "cc-sec tc-foot" }, SHIFTED_FOOT);
  const aboutId = `tc-about-${Math.random().toString(36).slice(2, 8)}`;
  const about = h("span", { class: "sr-only", id: aboutId });
  const info = h("span", { class: "tc-info", tabindex: "0", role: "img", "aria-label": "About this view", "aria-describedby": aboutId }, infoIcon());
  const tabs = order.map((v) => h("button", { type: "button", role: "tab", class: "tc-tab", "data-view": v, onclick: () => show(v, true) }, v));
  // Beside the card (it covers the rail), and above it where it has to overlap.
  withTooltip(
    info,
    () => {
      const v = o.views[view]!;
      return h("div", {}, h("div", { class: "tip-title" }, `${view} view`), h("div", { class: "tip-line" }, v.shows), h("div", { class: "tip-line" }, h("b", {}, "Answers: "), v.answers), v.shifted ? h("div", { class: "tip-line tc-shifted" }, h("b", {}, "Shifted by one step. "), SHIFTED) : null);
    },
    { anchor: "left", beside: () => info.closest(".hcard") ?? info, className: "tip-help tip-over" },
  );
  lightSources(list);
  const updateMore = floatingMore(list, () => Array.from(list.querySelectorAll<HTMLElement>(".tc-unit")), o.unit);

  const show = (v: CardView, chosen = false) => {
    view = v;
    if (chosen) lastView = v;
    const info = o.views[v]!;
    for (const t of tabs) t.setAttribute("aria-selected", String(t.dataset.view === v));
    list.replaceChildren(...o.render[v]!(o.ctx));
    list.scrollTop = 0;
    foot.hidden = !info.shifted;
    about.textContent = `${info.shows} ${info.answers}${info.shifted ? ` Shifted by one step. ${SHIFTED}` : ""}`;
    updateMore();
    if (chosen) keepInView(list);
  };
  const tablist = h("div", { class: "tc-views", role: "tablist", "aria-label": "View" }, ...tabs);
  tablist.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const next = order[(order.indexOf(view) + (e.key === "ArrowRight" ? 1 : order.length - 1)) % order.length]!;
    show(next, true);
    tabs.find((t) => t.dataset.view === next)?.focus();
  });
  show(view);

  return h(
    "div",
    { class: "hc tc" },
    h("div", { class: "hc-head" }, h("span", { class: "hc-title" }, o.title), h("span", { class: "hc-count" }, o.aside)),
    h("div", { class: "tc-bar-row" }, tablist, info, about),
    ...o.overview,
    list,
    foot,
  );
}

const pickThen =
  (close: () => void): Pick =>
  (go) =>
    go &&
    (() => {
      close();
      go();
    });

/** The card of a context-by-turn bar: `turns` is one, or the run merged into the bar. */
export function turnCard(turns: TurnInfo[], env: TurnCardEnv, close: () => void): HTMLElement {
  const models = turns.map((t) => model(t, env));
  const merged = models.length > 1;
  const first = models[0]!;
  const costs = models.flatMap((m) => (m.cost !== undefined && !m.inherited ? [m.cost] : []));
  const cost = costs.length ? formatCost(costs.reduce((a, b) => a + b, 0)) : undefined;
  const events = models.flatMap((m) => m.events);
  const worst = events.find((e) => e.kind === "miss") ?? events[0];
  const peak = Math.max(...models.map((m) => contextTokens(m.peak.usage)));
  const totalAdded = models.reduce((n, m) => n + m.added, 0);
  const totalOut = models.reduce((n, m) => n + m.output, 0);
  return viewCard({
    title: merged ? `${first.name} – ${models[models.length - 1]!.name}` : first.name,
    aside: merged ? plural(models.length, "turn") : (cost ?? ""),
    views: TURN_VIEWS,
    render: TURN_RENDER,
    ctx: { models, merged, run: false, pick: pickThen(close), env },
    overview: [
      h("div", { class: "cc-sec cb-facts tc-overview" }, [`${formatTokens(peak)} peak context`, `+${formatTokens(totalAdded)} added`, `${formatTokens(totalOut)} out`, ...(merged && cost ? [cost] : [])].join(" · ")),
      merged && worst ? h("div", { class: "cc-sec cc-caches" }, note(worst.kind, `${plural(events.length, "cache event")} in these turns`)) : null,
    ],
    unit: "turn",
  });
}

/** The card of a bar of the in-view turn's chart that merges the calls `ids`. */
export function callRunCard(t: TurnInfo, ids: string[], env: TurnCardEnv, close: () => void): HTMLElement {
  const m = narrow(model(t, env), new Set(ids));
  const events = m.events;
  const worst = events.find((e) => e.kind === "miss") ?? events[0];
  return viewCard({
    title: m.name,
    aside: m.cost !== undefined && !m.inherited ? formatCost(m.cost) : plural(m.calls.length, "call"),
    views: CALL_VIEWS,
    render: CALL_RENDER,
    ctx: { models: [m], merged: false, run: true, pick: pickThen(close), env },
    overview: [
      h("div", { class: "cc-sec cb-facts tc-overview" }, [plural(m.calls.length, "call"), `${formatTokens(contextTokens(m.peak.usage))} peak context`, `+${formatTokens(m.added)} added`, `${formatTokens(m.output)} out`].join(" · ")),
      worst ? h("div", { class: "cc-sec cc-caches" }, note(worst.kind, `${plural(events.length, "cache event")} in these calls`)) : null,
    ],
    unit: "call",
  });
}

/**
 * The card of one model call: where its prompt's new tokens came from and what its output and
 * results added to the next prompt, on one scale; then its prompt split as the bar draws it, and
 * every step it produced.
 */
export function callCard(t: TurnInfo, r: ResponseUsage, env: TurnCardEnv, close: () => void): HTMLElement {
  const m = model(t, env);
  const pick = pickThen(close);
  const call = m.calls.find((c) => c.r === r)!;
  const u = r.usage;
  const e = cacheEventOf(r);
  const sub = [r.model, r.purpose ? PURPOSE_LABEL[r.purpose] : undefined, r.inherited ? "inherited from the parent session" : undefined].filter(Boolean).join(" · ");

  let flow: HTMLElement;
  if (r.purpose) {
    flow = h("div", { class: "cc-sec" }, h("p", { class: "cc-muted" }, "Made outside the conversation: its prompt is its own, and what it returns isn't part of the next prompt."));
  } else {
    const inFrom = m.sources.find((s) => s.into === r);
    const out = m.sources.find((s) => s.from === call);
    const inV = added(r);
    const outV = out?.into ? added(out.into) : 0;
    const scale = Math.max(1, inV, outV);
    const track = (into: ResponseUsage, v: number) => {
      const fill = h("span", { class: "tc-io-fill" }, ...segs(addedParts(into)));
      fill.style.width = `${v ? Math.max(2, (v / scale) * 100) : 0}%`;
      return h("span", { class: "tc-io-track" }, fill);
    };
    const who = (s: Source | undefined): (Node | string)[] =>
      !s ? ["–"] : s.line.you ? [h("b", { class: "tc-you" }, "your prompt"), ", with the previous turn's last reply"] : [h("b", {}, s.line.what), ` ${s.line.text} · call ${s.from!.n}`];
    const nextCall = out?.into ? m.calls.find((c) => c.r === out.into) : undefined;
    flow = h(
      "div",
      { class: "cc-sec tc-io" },
      h("span", { class: "tc-io-lab" }, "in"),
      track(r, inV),
      h("span", { class: "tc-io-num" }, `+${formatTokens(inV)}`),
      pickable(pick(inFrom?.line.go), "tc-io-who", { title: inFrom ? sourceTitle(inFrom) : "" }, "from ", ...who(inFrom)),
      h("span", { class: "tc-io-lab" }, "out"),
      out?.into ? track(out.into, outV) : h("span", { class: "tc-io-track" }),
      h("span", { class: `tc-io-num${out?.into ? "" : " tc-z"}` }, out?.into ? `+${formatTokens(outV)}` : "→"),
      h("span", { class: "tc-io-who" }, out?.into ? `its output and results, into call ${nextCall?.n ?? "?"}` : "its reply goes into the next turn"),
    );
  }
  return h(
    "div",
    { class: "hc tc tc-call" },
    cardHead(`Model call ${call.n} of ${m.calls.length}`, !r.inherited && u.cost !== undefined ? formatCost(u.cost) : undefined, sub || undefined),
    flow,
    contextBlock(u),
    outputBlock(u.output, u.reasoning),
    cacheNotes(e ? [e] : []),
    call.acts.length
      ? h("div", { class: "cc-sec" }, h("div", { class: "cc-label" }, h("span", {}, "produced")), h("div", { class: "cb-lines" }, ...call.acts.map((a) => lineEl(a, null, pick))))
      : null,
    call.acts.some((a) => a.go) ? h("div", { class: "cc-hint" }, "Click a line to go to that step") : null,
  );
}
