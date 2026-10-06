/**
 * The card a bar of the context-by-turn chart opens, for one turn or several merged into the
 * bar. It has four views, picked from tabs at its top; the pick holds for every card until the
 * page is reloaded:
 *
 * - ledger: each turn's largest prompt split into cache read / cache write / uncached input,
 *   its output, and a line per model call.
 * - table, waterfall, bar: where each turn's new tokens came from, by source.
 *
 * Sources are your prompt, then each model call. The API reports new prompt tokens (cache
 * write and uncached input) on the call whose prompt carried them; these views credit them one
 * step back, to what produced them: the first call's to your prompt (and the previous turn's
 * last reply, which can't be told apart from it), each later call's to the call before it (its
 * output and tool results). The last call's reply lands in the next turn's first prompt. Calls
 * outside the conversation (a compaction, a background call) have prompts of their own and are
 * left out of the sources.
 */
import { cacheEventDetail, cacheEventLabel, formatCost, formatTokens, plural } from "../../src/format.ts";
import { contextTokens, type CacheEvent, type ResponseUsage, type Step } from "../../src/schema.ts";
import { cardRow, floatingMore, note, SEGMENTS, stepActivity, type Activity } from "./chartcard.ts";
import { h, withTooltip } from "./dom.ts";
import { infoIcon } from "./el.ts";
import { turnSubagentsLine } from "./subagents.ts";
import type { TurnInfo } from "./transcript.ts";
import { cacheEventOf } from "./usageinfo.ts";

export type TurnView = "ledger" | "table" | "waterfall" | "bar";

const VIEWS: Record<TurnView, { shows: string; answers: string; shifted: boolean }> = {
  ledger: {
    shows: "Each turn's largest prompt split into cache read, cache write and uncached input, then its output, and a line per model call with the size of that call's prompt.",
    answers: "How big did the context get, and how much of it came from cache?",
    shifted: false,
  },
  table: {
    shows: "A row per source of new tokens: your prompt, then each model call. Columns: the context after it, the cache write and uncached input it added, and the call's own output, each on its own scale. Tool calls a model call made at once share its row and are listed under it.",
    answers: "Which step grew the context, and by how much?",
    shifted: true,
  },
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
const ORDER: TurnView[] = ["ledger", "table", "waterfall", "bar"];
const SHIFTED =
  "The API reports new tokens on the call whose prompt carried them. Here a call is credited with what its output and tool results added to the next prompt, and the first row is your prompt (with the previous turn's last reply). The last call's reply counts in the next turn (→). Totals are unchanged.";
const SHIFTED_FOOT = "+N: what a step added to the next prompt · →: counts in the next turn";

/** The view every card opens in; kept until the page is reloaded. */
let view: TurnView = "ledger";

export function setTurnView(v: TurnView): void {
  view = v;
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

/** Lines listed per turn when several turns share the card; the rest are counted. */
const MERGED_LINES = 5;
/** Share of a bar the cut cache read keeps (a waterfall's track is narrower, so less). */
const STUB = 15;
const WF_STUB = 10;
/** A source wider than this share of the bar is named inside it. */
const LABEL_SHARE = 0.2;
const NOT_TOOLS = new Set(["reply", "thinking", "event"]);

interface Line extends Activity {
  go?: () => void;
  /** Other steps of the same call, besides the one named. */
  extra?: number;
  you?: true;
}

interface Source {
  /** Ties a row or chip to its piece of the bar. */
  key: string;
  line: Line;
  /** Tool calls the model call made at once, listed under its row. */
  batch: Line[];
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
  calls: { r: ResponseUsage; line: Line }[];
  /** Calls outside the conversation (compaction, background…), left out of the sources. */
  aside: number;
  carried: number;
  end: number;
  write: number;
  input: number;
  added: number;
  sources: Source[];
  events: CacheEvent[];
}

/** What a model call did, as one line: a batch of tool calls is "Read ×3 a · b · c". */
function callLine(r: ResponseUsage, t: TurnInfo, env: TurnCardEnv): { line: Line; batch: Line[] } {
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
    return { line: acts.length > tools.length ? { ...line, extra: acts.length - tools.length } : line, batch: tools };
  }
  // A tool names the line over the reply or thinking around it: its result is what the next prompt carries.
  const main = tools[0] ?? acts.find((a) => a.what !== "thinking") ?? acts[0];
  if (!main) return { line: { what: "call", text: "", ...callGo }, batch: [] };
  return { line: { ...callGo, ...main, ...error, ...(acts.length > 1 ? { extra: acts.length - 1 } : {}) }, batch: [] };
}

function model(t: TurnInfo, env: TurnCardEnv): Model {
  const own = t.responses.filter((r) => !r.inherited);
  const costs = own.flatMap((r) => (r.usage.cost !== undefined ? [r.usage.cost] : []));
  const calls = t.responses.map((r) => ({ r, ...callLine(r, t, env) }));
  const chain = calls.filter((c) => !c.r.purpose);
  const sources: Source[] = chain.length
    ? [
        { key: `${t.index}-p`, line: { what: "you", text: t.label, you: true, go: () => env.onJump(t.index) }, batch: [], into: chain[0]!.r },
        ...chain.map((c, k) => ({ key: `${t.index}-${k}`, line: c.line, batch: c.batch, into: chain[k + 1]?.r, output: c.r.usage.output })),
      ]
    : [];
  const write = chain.reduce((n, c) => n + c.r.usage.cacheWrite, 0);
  const input = chain.reduce((n, c) => n + c.r.usage.input, 0);
  return {
    t,
    name: t.ordinal ? `Turn ${t.ordinal}` : "Start",
    ...(costs.length ? { cost: costs.reduce((a, b) => a + b, 0) } : {}),
    inherited: own.length === 0,
    fromParent: t.responses.length - own.length,
    peak: t.responses.reduce((a, b) => (contextTokens(b.usage) > contextTokens(a.usage) ? b : a)),
    output: t.responses.reduce((n, r) => n + r.usage.output, 0),
    reasoning: t.responses.reduce((n, r) => n + r.usage.reasoning, 0),
    calls,
    aside: calls.length - chain.length,
    carried: chain[0]?.r.usage.cacheRead ?? 0,
    end: chain.length ? contextTokens(chain[chain.length - 1]!.r.usage) : 0,
    write,
    input,
    added: write + input,
    sources,
    events: t.responses.flatMap((r) => cacheEventOf(r) ?? []),
  };
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

const added = (r: ResponseUsage): number => r.usage.cacheWrite + r.usage.input;

function segs(parts: [string, number][]): HTMLElement[] {
  return parts.flatMap(([cls, v]) => {
    if (v <= 0) return [];
    const seg = h("span", { class: `seg ${cls}` });
    seg.style.flexGrow = String(v);
    return [seg];
  });
}

/** The cache read a turn started from, cut short behind a break mark, taking `width`% of the bar. */
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

function lineEl(l: Line, left: string, pick: Pick, o: { hot?: boolean; src?: string; title?: string } = {}): HTMLElement {
  return pickable(
    pick(l.go),
    `hc-item cb-line${l.error ? " is-error" : ""}`,
    { title: o.title ?? l.text, ...(o.src ? { "data-src": o.src } : {}) },
    h("span", { class: `cb-ctx${o.hot ? " hot" : ""}` }, left),
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

function cacheLines(m: Model, max = 2): HTMLElement[] {
  return [...m.events.slice(0, max).map((e) => note(e.kind, `${cacheEventLabel(e)}: ${cacheEventDetail(e)}`)), ...(m.events.length > max ? [h("p", { class: "cc-more tc-pad" }, `+${m.events.length - max} more cache events`)] : [])].map((el) => {
    el.classList.add("tc-pad");
    return el;
  });
}

interface Ctx {
  models: Model[];
  merged: boolean;
  pick: Pick;
  env: TurnCardEnv;
}

// ---------- ledger ----------
function ledger({ models, merged, pick, env }: Ctx): HTMLElement[] {
  const top = Math.max(1, ...models.map((m) => contextTokens(m.peak.usage)));
  return models.map((m) => {
    const u = m.peak.usage;
    const ctx = contextTokens(u);
    const bar = h("div", { class: "cc-bar cb-bar", "aria-hidden": "true" }, ...segs(SEGMENTS.map(([k, cls]) => [cls, u[k] ?? 0])));
    bar.style.width = `${Math.max(2, (ctx / top) * 100)}%`;
    const max = merged ? MERGED_LINES : Infinity;
    return h(
      "section",
      { class: `cb-entry tc-turn${m.inherited ? " is-inh" : ""}` },
      head(m, merged, pick, env.onJump),
      h(
        "div",
        { class: "tc-pad tc-ledger" },
        h("div", { class: "cc-total" }, h("span", {}, m.t.responses.length > 1 ? "peak context" : "context"), h("span", { class: "cc-v" }, formatTokens(ctx))),
        ctx ? bar : null,
        ...SEGMENTS.map(([k, cls, name]) => cardRow(name, formatTokens(u[k] ?? 0), { swatch: cls, extra: share(u[k] ?? 0, ctx), muted: !u[k] })),
        cardRow("output", formatTokens(m.output), { swatch: "seg-output", note: m.reasoning ? `(${formatTokens(m.reasoning)} thinking)` : undefined }),
      ),
      ...facts(m),
      ...cacheLines(m),
      h("div", { class: "cb-lines" }, ...m.calls.slice(0, max).map((c) => lineEl(c.line, formatTokens(contextTokens(c.r.usage)), pick))),
      more(m.calls.length - max, "call"),
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
const scaleOf = (rows: { ctx: number; write: number; input: number; out: number }[]): Scale => ({
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

function table({ models, merged, pick, env }: Ctx): HTMLElement[] {
  const into = (s: Source) => (s.into ? { ctx: contextTokens(s.into.usage), write: s.into.usage.cacheWrite, input: s.into.usage.input } : undefined);
  const rows = models.flatMap((m) => m.sources.map((s) => ({ ...(into(s) ?? { ctx: 0, write: 0, input: 0 }), out: s.output ?? 0 })));
  const sc = scaleOf(rows);
  const turnScale = scaleOf(models.map((m) => ({ ctx: m.end, write: m.write, input: m.input, out: m.output })));
  const row = (go: (() => void) | undefined, cls: string, label: (Node | string)[], cells: HTMLElement[], attrs: Record<string, string> = {}) =>
    pickable(go, `tc-row ${cls}`, attrs, h("span", { class: "tc-lab" }, ...label), ...cells);
  const max = merged ? MERGED_LINES - 1 : Infinity;
  const body = models.flatMap((m) => {
    const turnRow = merged
      ? [row(pick(() => env.onJump(m.t.index)), "tc-turnrow tc-turn", [h("b", {}, m.name), m.cost !== undefined && !m.inherited ? ` ${formatCost(m.cost)}` : ""], [num(m.end, turnScale.ctx, "seg-cache-read"), num(m.write, turnScale.write, "seg-cache-write", true), num(m.input, turnScale.input, "seg-input", true), num(m.output, turnScale.out, "seg-output")], { title: m.t.label })]
      : [];
    if (!m.sources.length) return [...turnRow, h("p", { class: "cc-muted tc-pad" }, "No conversation calls in this turn.")];
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
      const title = s.line.you ? "Your prompt, with the previous turn's last reply" : v ? `${s.line.text}\nIts output and results added ${formatTokens(added(s.into!))} to the next prompt` : `${s.line.text}\nIts reply goes into the next turn`;
      return [
        row(pick(s.line.go), `${s.line.you ? "tc-yourow" : "tc-callrow"}${s.line.error ? " is-error" : ""}`, label, cells, { title }),
        ...s.batch.map((b) => row(pick(b.go), `tc-subrow${b.error ? " is-error" : ""}`, [`${b.what} ${b.text}`], [], { title: b.text })),
      ];
    });
    return [...turnRow, ...lines, ...(m.sources.length > shown.length ? [more(m.sources.length - shown.length, "call")!] : [])];
  });
  const total = merged
    ? []
    : models.map((m) => h("div", { class: "tc-row tc-sum" }, h("span", { class: "tc-lab" }, "turn"), num(m.end, sc.ctx, ""), num(m.write, sc.write, "", true), num(m.input, sc.input, "", true), num(m.output, sc.out, "")));
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
function waterfall({ models, merged, pick, env }: Ctx): HTMLElement[] {
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
      const title = s.line.you ? "Your prompt, with the previous turn's last reply" : s.into ? `${s.line.text}\nIts output and results added ${formatTokens(v)} to the next prompt` : `${s.line.text}\nIts reply goes into the next turn`;
      const el = lineEl(s.line, s.into ? `+${formatTokens(v)}` : "→", pick, { hot: v > m.added / 3, src: s.key, title });
      el.classList.add("tc-wf-row");
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
      { class: `cb-entry tc-turn${m.inherited ? " is-inh" : ""}` },
      merged || m.t.ordinal ? head(m, merged, pick, env.onJump) : null,
      m.sources.length ? h("div", { class: "tc-lit tc-wf" }, top, ...rowEls) : h("p", { class: "cc-muted tc-pad" }, "No conversation calls in this turn."),
      more(m.sources.length - rows.length, "call"),
      ...facts(m, `${formatTokens(m.output)} out`),
      ...cacheLines(m),
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
      const title = s.line.you ? "Your prompt, with the previous turn's last reply" : `${s.line.text}\nIts output and results added ${formatTokens(v)} to the next prompt`;
      return pickable(
        pick(s.line.go),
        `tc-chip${s.line.you ? " is-you" : ""}${s.line.error ? " is-error" : ""}`,
        { "data-src": s.key, title },
        h("i", {}, s.line.what),
        v > m.added / 3 ? h("b", {}, `+${formatTokens(v)}`) : `+${formatTokens(v)}`,
      );
    });
    return h(
      "section",
      { class: `cb-entry tc-turn${m.inherited ? " is-inh" : ""}` },
      merged || m.t.ordinal ? head(m, merged, pick, env.onJump) : null,
      m.sources.length
        ? h(
            "div",
            { class: "tc-lit tc-pad" },
            h("div", { class: "tc-caption" }, h("span", {}, `${formatTokens(m.carried)} → ${formatTokens(m.end)} context`), h("span", {}, `+${formatTokens(m.added)} this turn`)),
            h("div", { class: "tc-lb", "aria-hidden": "true" }, stub(m.carried, true), src),
            h("div", { class: "tc-chips" }, ...chips),
          )
        : h("p", { class: "cc-muted tc-pad" }, "No conversation calls in this turn."),
      ...facts(m, `${formatTokens(m.output)} out`),
      ...cacheLines(m),
    );
  });
}

const RENDER: Record<TurnView, (c: Ctx) => HTMLElement[]> = { ledger, table, waterfall, bar: bars };

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

/**
 * The card for `turns` (one, or the run merged into a bar). `close` dismisses it, after a line
 * is picked.
 */
export function turnCard(turns: TurnInfo[], env: TurnCardEnv, close: () => void): HTMLElement {
  const models = turns.map((t) => model(t, env));
  const merged = models.length > 1;
  const first = models[0]!;
  const pick: Pick = (go) =>
    go &&
    (() => {
      close();
      go();
    });
  const peak = Math.max(...models.map((m) => contextTokens(m.peak.usage)));
  const totalAdded = models.reduce((n, m) => n + m.added, 0);
  const totalOut = models.reduce((n, m) => n + m.output, 0);
  const costs = models.flatMap((m) => (m.cost !== undefined && !m.inherited ? [m.cost] : []));
  const cost = costs.length ? formatCost(costs.reduce((a, b) => a + b, 0)) : undefined;
  const events = models.flatMap((m) => m.events);
  const worst = events.find((e) => e.kind === "miss") ?? events[0];

  const list = h("div", { class: "hc-list tc-list" });
  const foot = h("div", { class: "cc-sec tc-foot" }, SHIFTED_FOOT);
  const about = h("span", { class: "sr-only" });
  const info = h("span", { class: "tc-info", tabindex: "0", role: "img", "aria-label": "About this view" }, infoIcon());
  const tabs = ORDER.map((v) => h("button", { type: "button", role: "tab", class: "tc-tab", "data-view": v, onclick: () => show(v, true) }, v));
  const aboutId = `tc-about-${Math.random().toString(36).slice(2, 8)}`;
  about.id = aboutId;
  info.setAttribute("aria-describedby", aboutId);
  // Beside the card (it covers the rail), and above it where it has to overlap.
  withTooltip(
    info,
    () => {
      const v = VIEWS[view];
      return h("div", {}, h("div", { class: "tip-title" }, `${view} view`), h("div", { class: "tip-line" }, v.shows), h("div", { class: "tip-line" }, h("b", {}, "Answers: "), v.answers), v.shifted ? h("div", { class: "tip-line tc-shifted" }, h("b", {}, "Shifted by one step. "), SHIFTED) : null);
    },
    { anchor: "left", beside: () => info.closest(".hcard") ?? info, className: "tip-help tip-over" },
  );
  lightSources(list);
  const updateMore = floatingMore(list, () => Array.from(list.querySelectorAll<HTMLElement>(".tc-turn")), "turn");

  const show = (v: TurnView, chosen = false) => {
    view = v;
    for (const t of tabs) t.setAttribute("aria-selected", String(t.dataset.view === v));
    list.replaceChildren(...RENDER[v]({ models, merged, pick, env }));
    list.scrollTop = 0;
    foot.hidden = !VIEWS[v].shifted;
    about.textContent = `${VIEWS[v].shows} ${VIEWS[v].answers}${VIEWS[v].shifted ? ` Shifted by one step. ${SHIFTED}` : ""}`;
    updateMore();
    if (chosen) keepInView(list);
  };
  const tablist = h("div", { class: "tc-views", role: "tablist", "aria-label": "View" }, ...tabs);
  tablist.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const next = ORDER[(ORDER.indexOf(view) + (e.key === "ArrowRight" ? 1 : ORDER.length - 1)) % ORDER.length]!;
    show(next, true);
    tabs.find((t) => t.dataset.view === next)?.focus();
  });
  show(view);

  return h(
    "div",
    { class: "hc tc" },
    h(
      "div",
      { class: "hc-head" },
      h("span", { class: "hc-title" }, merged ? `${first.name} – ${models[models.length - 1]!.name}` : first.name),
      h("span", { class: "hc-count" }, merged ? plural(models.length, "turn") : (cost ?? "")),
    ),
    h("div", { class: "tc-bar-row" }, tablist, info, about),
    h(
      "div",
      { class: "cc-sec cb-facts tc-overview" },
      [`${formatTokens(peak)} peak context`, `+${formatTokens(totalAdded)} added`, `${formatTokens(totalOut)} out`, ...(merged && cost ? [cost] : [])].join(" · "),
    ),
    merged && worst ? h("div", { class: "cc-sec cc-caches" }, note(worst.kind, `${plural(events.length, "cache event")} in these turns`)) : null,
    list,
    foot,
  );
}
