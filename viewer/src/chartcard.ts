/**
 * Pieces of the cards the token charts' bars open (turncard.ts builds the cards): a prompt
 * split into cache read / cache write / uncached input and drawn to scale, output and cost,
 * cache events, what a model call produced in the transcript, and the pill a long list floats
 * at its bottom. Built from the same colour slots as the charts, so a card reads as a close-up
 * of the bar under the pointer.
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
