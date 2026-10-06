/**
 * The cards the token charts show on hover: what a bar stands for (a turn, a run of turns
 * or a model call), its context split into cache read / cache write / uncached input and
 * drawn to scale, its output and cost, its cache events and, for a model call, what it
 * produced in the transcript. Built from the same colour slots as the charts, so a card
 * reads as a close-up of the bar under the pointer.
 *
 * A bar that stands for a run of turns (or calls) opens a hover card instead: a section per
 * member that can be scrolled through and clicked, see bucketCard.
 */
import { cacheEventDetail, cacheEventLabel, formatCost, formatTokens, plural } from "../../src/format.ts";
import { contextTokens, type CacheEvent, type CacheEventKind, type Step, type Usage } from "../../src/schema.ts";
import { h } from "./dom.ts";
import { firstLine } from "./text.ts";
import { plainLine, relTo } from "./transcript.ts";
import { cacheMark } from "./usageinfo.ts";

export const SEGMENTS: [keyof Usage, string, string][] = [
  ["cacheRead", "seg-cache-read", "cache read"],
  ["cacheWrite", "seg-cache-write", "cache write"],
  ["input", "seg-input", "uncached input"],
];

type Child = Node | string | null | undefined | false;

/** The tooltip class that sizes and pads a card. */
export const CARD_CLASS = "tip-card";

export function card(...children: Child[]): HTMLElement {
  return h("div", { class: "cc" }, ...children);
}

/** Title with a figure on the right (usually the cost), and an optional quieter line under it. */
export function cardHead(title: string, aside?: string, sub?: string): HTMLElement {
  return h(
    "div",
    { class: "cc-head" },
    h("div", { class: "cc-titles" }, h("span", { class: "cc-title" }, title), aside ? h("span", { class: "cc-aside" }, aside) : null),
    sub ? h("div", { class: "cc-sub" }, sub) : null,
  );
}

const share = (v: number, total: number): string => {
  if (!v || !total) return "";
  const p = (v / total) * 100;
  return p < 1 ? "<1%" : `${Math.round(p)}%`;
};

interface RowOptions {
  swatch?: string;
  /** Quieter text after the label ("400 thinking"). */
  note?: string;
  extra?: string;
  muted?: boolean;
  error?: boolean;
}

/** One figure: [swatch] label · value · share. */
export function cardRow(label: string, value: string, o: RowOptions = {}): HTMLElement {
  return h(
    "div",
    { class: `cc-row${o.muted ? " is-muted" : ""}${o.error ? " is-error" : ""}` },
    h("span", { class: o.swatch ? `sw ${o.swatch}` : "cc-nosw" }),
    h("span", { class: "cc-k" }, label, o.note ? h("span", { class: "cc-note" }, ` ${o.note}`) : null),
    h("span", { class: "cc-v" }, value),
    h("span", { class: "cc-x" }, o.extra ?? ""),
  );
}

/** A prompt's size, then what it was made of: one bar split to scale and a row per part. */
export function contextBlock(u: Usage, label = "context"): HTMLElement {
  const total = contextTokens(u);
  const bar = h("div", { class: "cc-bar", "aria-hidden": "true" });
  for (const [key, cls] of SEGMENTS) {
    const v = u[key] ?? 0;
    if (!v) continue;
    const seg = h("span", { class: `seg ${cls}` });
    seg.style.flexGrow = String(v);
    bar.append(seg);
  }
  return h(
    "div",
    { class: "cc-sec" },
    h("div", { class: "cc-total" }, h("span", {}, label), h("span", { class: "cc-v" }, formatTokens(total))),
    total ? bar : null,
    ...SEGMENTS.map(([key, cls, name]) => {
      const v = u[key] ?? 0;
      return cardRow(name, formatTokens(v), { swatch: cls, extra: share(v, total), muted: !v });
    }),
  );
}

/** Output (with its thinking share) and what it all cost, under the context block. */
export function outputBlock(output: number, reasoning: number, cost?: string, ...more: Child[]): HTMLElement {
  return h(
    "div",
    { class: "cc-sec" },
    cardRow("output", formatTokens(output), { swatch: "seg-output", note: reasoning ? `(${formatTokens(reasoning)} thinking)` : undefined }),
    cost ? cardRow("est. cost", cost) : null,
    ...more,
  );
}

export const note = (kind: CacheEventKind, text: string) => h("p", { class: `cc-cache cc-cache-${kind}` }, cacheMark(kind), h("span", {}, text));

/** One line per cache event ("cache miss after 4h 31m idle: 385k re-cached, ~$3.01"). */
export function cacheNotes(events: CacheEvent[], max = 3): HTMLElement | null {
  if (!events.length) return null;
  return h(
    "div",
    { class: "cc-sec cc-caches" },
    ...events.slice(0, max).map((e) => note(e.kind, `${cacheEventLabel(e)}: ${cacheEventDetail(e)}`)),
    events.length > max ? h("p", { class: "cc-more" }, `+${events.length - max} more cache events`) : null,
  );
}

/** For a run of bars too narrow to tell apart: how many events they hold, marked by the worst. */
export function cacheCount(kind: CacheEventKind, text: string): HTMLElement {
  return h("div", { class: "cc-sec cc-caches" }, note(kind, text));
}

/** A small chart of several prompts (a turn's calls, a run of turns) on their own scale. */
export function sparkBlock(list: Usage[], label: string, max = 48): HTMLElement | null {
  if (list.length < 2) return null;
  const size = Math.ceil(list.length / max);
  const peaks: Usage[] = [];
  for (let i = 0; i < list.length; i += size) peaks.push(list.slice(i, i + size).reduce((a, b) => (contextTokens(b) > contextTokens(a) ? b : a)));
  const top = Math.max(1, ...peaks.map(contextTokens));
  const H = 28;
  const cols = h("div", { class: "cc-spark", "aria-hidden": "true" });
  cols.style.height = `${H}px`;
  for (const u of peaks) {
    const col = h("span", { class: "cc-spark-col" });
    const ctx = contextTokens(u);
    const total = Math.max(ctx ? 2 : 0, Math.round((ctx / top) * H));
    for (const [key, cls] of SEGMENTS) {
      const v = u[key] ?? 0;
      if (!v) continue;
      const seg = h("span", { class: `seg ${cls}` });
      seg.style.height = `${Math.max(1, (v / Math.max(1, ctx)) * total)}px`;
      col.append(seg);
    }
    cols.append(col);
  }
  return h("div", { class: "cc-sec" }, h("div", { class: "cc-label" }, h("span", {}, label), h("span", {}, `peak ${formatTokens(top)}`)), cols);
}

/** A step a model call produced, as one line of its card. */
export interface Activity {
  what: string;
  text: string;
  error?: boolean;
}

/**
 * What these steps did, in transcript order (a call's reply, thinking, tool calls…). A step
 * that can't be read (a share is untrusted) gets a line saying so, like its transcript placeholder.
 */
export function stepActivity(steps: Step[], cwd?: string): Activity[] {
  return steps.flatMap((s): Activity[] => {
    try {
      return activityOf(s, cwd);
    } catch {
      return [{ what: "?", text: "couldn't be shown" }];
    }
  });
}

function activityOf(s: Step, cwd: string | undefined): Activity[] {
  switch (s.kind) {
    case "text":
      return [{ what: "reply", text: plainLine(s.text, 120) }];
    case "thinking":
      return [{ what: "thinking", text: s.text ? plainLine(s.text, 120) : s.chars ? `${s.chars.toLocaleString("en-US")} chars` : plural(s.blocks, "block") }];
    case "tool":
      return [{ what: s.name, text: relTo(cwd, firstLine(s.summary || "", 120)), ...(s.isError || s.result?.isError ? { error: true } : {}) }];
    case "toolGroup":
      return [{ what: "tools", text: s.calls.map((c) => `${c.name} ×${c.count}`).join(" · "), ...(s.calls.some((c) => c.errors) ? { error: true } : {}) }];
    case "subagent":
      return [{ what: "agent", text: s.description ?? s.agents.join(", "), ...(s.isError ? { error: true } : {}) }];
    case "event":
      return [{ what: "event", text: firstLine(s.text, 120) }];
    default:
      return [];
  }
}

export function activityBlock(items: Activity[], label: string, max = 6): HTMLElement | null {
  if (!items.length) return null;
  return h(
    "div",
    { class: "cc-sec" },
    h("div", { class: "cc-label" }, h("span", {}, label)),
    h(
      "div",
      { class: "cc-acts" },
      ...items.slice(0, max).map((a) => h("div", { class: `cc-act${a.error ? " is-error" : ""}` }, h("span", { class: "cc-act-what" }, a.what), h("span", { class: "cc-act-text" }, a.text || "–"))),
    ),
    items.length > max ? h("p", { class: "cc-more" }, `+${items.length - max} more`) : null,
  );
}

/** The quiet last line: what clicking the bar does. */
export function cardHint(text: string): HTMLElement {
  return h("div", { class: "cc-hint" }, text);
}

/** One line of a bucket entry: a turn's model call, or a step a call produced. */
export interface BucketLine extends Activity {
  /** The call's prompt size. */
  context?: number;
  /** More steps the call produced, besides the one named. */
  extra?: number;
  go?: () => void;
}

/** A turn or a model call in a bucket's card. */
export interface BucketEntry {
  name: string;
  /** What it was about: a turn's prompt. */
  label?: string;
  cost?: number;
  context: Usage;
  facts: string[];
  lines: BucketLine[];
  /** Lines left out ("+12 more calls"). */
  more?: string;
  cacheEvents: CacheEvent[];
  inherited?: boolean;
  go?: () => void;
}

/** A line or heading of an entry: a button when it leads somewhere. */
function pickable(go: (() => void) | undefined, cls: string, title: string | undefined, ...children: Child[]): HTMLElement {
  return go
    ? h("button", { type: "button", class: cls, "data-hc-item": "", title, onclick: go }, ...children)
    : h("div", { class: `${cls} is-static`, title }, ...children);
}

function entrySection(e: BucketEntry, top: number, pick: (go?: () => void) => (() => void) | undefined): HTMLElement {
  const ctx = contextTokens(e.context);
  const bar = h("div", { class: "cc-bar cb-bar", "aria-hidden": "true" });
  // Against the bucket's largest prompt, so its members compare at a glance.
  bar.style.width = `${Math.max(2, (ctx / top) * 100)}%`;
  for (const [key, cls] of SEGMENTS) {
    const v = e.context[key] ?? 0;
    if (!v) continue;
    const seg = h("span", { class: `seg ${cls}` });
    seg.style.flexGrow = String(v);
    bar.append(seg);
  }
  return h(
    "section",
    { class: `cb-entry${e.inherited ? " is-inh" : ""}` },
    pickable(
      pick(e.go),
      "cb-head",
      e.label,
      h("span", { class: "cb-titles" }, h("span", { class: "cb-name" }, e.name), e.cost !== undefined ? h("span", { class: "cb-cost" }, formatCost(e.cost)) : null),
      e.label ? h("span", { class: "cb-label" }, e.label) : null,
    ),
    h("div", { class: "cb-stats" }, ctx ? bar : null, h("div", { class: "cb-facts" }, e.facts.join(" · "))),
    ...e.cacheEvents.slice(0, 2).map((c) => note(c.kind, `${cacheEventLabel(c)}: ${cacheEventDetail(c)}`)),
    e.lines.length
      ? h(
          "div",
          { class: "cb-lines" },
          ...e.lines.map((l) =>
            pickable(
              pick(l.go),
              `hc-item cb-line${l.error ? " is-error" : ""}`,
              l.text,
              l.context !== undefined ? h("span", { class: "cb-ctx" }, formatTokens(l.context)) : null,
              h("span", { class: "cb-what" }, l.what),
              h("span", { class: "hc-text" }, l.text || "–"),
              l.extra ? h("span", { class: "hc-n" }, `+${l.extra}`) : null,
            ),
          ),
        )
      : null,
    e.more ? h("p", { class: "cc-more cb-more" }, e.more) : null,
  );
}

/** Close enough to the end of the list that nothing worth pointing at is left below. */
const NEAR_END = 16;

/**
 * "↓ 4 more turns": a pill floating at the bottom of a scrolling list while there is more below
 * it, counting the `items` (one per member) that start below the fold. Returns the update to run
 * when the list is refilled; the pill puts itself back if the refill removed it.
 */
export function floatingMore(list: HTMLElement, items: () => HTMLElement[], unit: string): () => void {
  const label = h("span", {});
  const float = h(
    "div",
    { class: "cb-float is-hidden", "aria-hidden": "true" },
    h("span", { class: "cb-pill", onclick: () => list.scrollBy?.({ top: list.clientHeight * 0.8, behavior: "smooth" }) }, "↓ ", label),
  );
  const update = () => {
    if (float.parentNode !== list) list.append(float);
    const bottom = list.scrollTop + list.clientHeight;
    const below = items().filter((s) => s.offsetTop >= bottom).length;
    float.classList.toggle("is-hidden", list.scrollHeight - bottom <= NEAR_END);
    label.textContent = below ? plural(below, `more ${unit}`) : "more below";
  };
  list.addEventListener("scroll", update, { passive: true });
  update();
  // Measured once the card is placed and its height capped.
  requestAnimationFrame(update);
  return update;
}

/**
 * The card of a bar that merges several turns (or calls): an overview that stays put, then a
 * section per member, each with its context drawn to the bucket's scale and its model calls
 * (or what the call produced) as lines that go there. The list scrolls; while there is more
 * below, a pill floating at its bottom says how much.
 */
export function bucketCard(title: string, unit: string, entries: BucketEntry[], overview: Child[], close: () => void): HTMLElement {
  const top = Math.max(1, ...entries.map((e) => contextTokens(e.context)));
  const pick = (go?: () => void) =>
    go &&
    (() => {
      close();
      go();
    });
  const sections = entries.map((e) => entrySection(e, top, pick));
  const list = h("div", { class: "hc-list cb-list" }, ...sections);
  floatingMore(list, () => sections, unit);
  return h(
    "div",
    { class: "hc cb" },
    h("div", { class: "hc-head" }, h("span", { class: "hc-title" }, title), h("span", { class: "hc-count" }, plural(entries.length, unit))),
    ...overview,
    list,
  );
}
