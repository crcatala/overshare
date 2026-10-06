/**
 * The cards the token charts show on hover: what a bar stands for (a turn, a run of turns
 * or a model call), its context split into cache read / cache write / uncached input and
 * drawn to scale, its output and cost, its cache events and, for a model call, what it
 * produced in the transcript. Built from the same colour slots as the charts, so a card
 * reads as a close-up of the bar under the pointer.
 */
import { cacheEventDetail, cacheEventLabel, formatTokens, plural } from "../../src/format.ts";
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

const note = (kind: CacheEventKind, text: string) => h("p", { class: `cc-cache cc-cache-${kind}` }, cacheMark(kind), h("span", {}, text));

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

/** What these steps did, in transcript order (a call's reply, thinking, tool calls…). */
export function stepActivity(steps: Step[], cwd?: string): Activity[] {
  return steps.flatMap((s): Activity[] => {
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
  });
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
