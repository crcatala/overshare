/** Cost and out-of-scope usage figures with the tooltips that say what they mean; used by the header and the token rail. */
import { describeCost, formatCacheMisses, formatSessionCost, formatTokens, formatUsageTotals } from "../../src/format.ts";
import { totalTokens, type CacheEvent, type CacheEventKind, type CacheSummary, type ResponseUsage, type SessionStats, type Usage, type UsageTotals } from "../../src/schema.ts";
import { h, withTooltip } from "./dom.ts";
import { svg } from "./el.ts";

/** Tokens processed: every call re-reads the context, so hover says what it is made of. */
export function tokensNode(st: { tokens: Usage }): HTMLElement {
  const t = st.tokens;
  const el = h("span", { class: "has-tip", tabindex: "0" }, formatTokens(totalTokens(t)));
  withTooltip(el, () => [
    "Tokens processed",
    "Counts the whole prompt of every model call, so context re-read from cache is counted again each time. It is far more than the length of the conversation.",
    `cache read ${formatTokens(t.cacheRead)} · cache write ${formatTokens(t.cacheWrite)} · uncached input ${formatTokens(t.input)} · output ${formatTokens(t.output)}`,
  ]);
  return el;
}

const CACHE_KINDS: ReadonlySet<string> = new Set<CacheEventKind>(["miss", "rebuild", "model-switch"]);

/**
 * A call's cache event as the viewer may trust it. A share is untrusted input and `kind` becomes a CSS class, so an
 * event with an unknown kind or a non-numeric size is ignored, and non-numeric gaps and costs are dropped, rather
 * than drawing odd classes or "NaN".
 */
export function cacheEventOf(r: ResponseUsage): CacheEvent | undefined {
  const e = r.cacheEvent as Partial<Record<keyof CacheEvent, unknown>> | undefined;
  if (!e || typeof e.kind !== "string" || !CACHE_KINDS.has(e.kind)) return undefined;
  const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);
  const recached = num(e.recached);
  if (recached === undefined) return undefined;
  const gapMs = num(e.gapMs);
  const cost = num(e.cost);
  return { kind: e.kind as CacheEventKind, recached, ...(gapMs !== undefined ? { gapMs } : {}), ...(e.idle === true ? { idle: true as const } : {}), ...(cost !== undefined ? { cost } : {}) };
}

/** What a cache miss is; shared by the rail heading and the header figure. */
export const CACHE_HELP = [
  "A miss is a model call that had to re-process much of the prompt the previous call could have read from cache: over 5% and at least 2,000 tokens, as Claude Code counts it. For agents whose provider reports no cache writes (OpenAI-style, coarser caches) it takes over half and 10,000 tokens.",
  "Caches expire when unused, typically after 5 minutes to 1 hour depending on plan and provider, so the first call after a long pause re-writes the whole prompt at a higher price.",
  "Compaction and switching models are expected: the prompt changed or the cache is per model.",
  "Gap is the time since the previous model call. Extra cost is the estimated difference from reading those tokens from cache.",
];

/** The header figure "cache misses: N (~$X)", with the explanation on hover. */
export function cacheMissesNode(c: CacheSummary): HTMLElement {
  const el = h("span", { class: "has-tip", tabindex: "0" }, formatCacheMisses(c));
  withTooltip(el, () => ["Cache misses", ...CACHE_HELP]);
  return el;
}

/**
 * A small shape that marks a cache event where colour alone would not say it: a filled downward
 * triangle for a miss, an open diamond for an expected rebuild or model switch.
 */
export function cacheMark(kind: CacheEventKind): SVGElement {
  const miss = kind === "miss";
  return svg(
    "svg",
    { viewBox: "0 0 10 10", width: "9", height: "9", class: `mark ${miss ? "mark-miss" : "mark-expected"}`, "aria-hidden": "true", focusable: "false" },
    miss ? svg("path", { d: "M1 1.5h8L5 9z", fill: "currentColor" }) : svg("path", { d: "M5 1.2 8.8 5 5 8.8 1.2 5z", fill: "none", stroke: "currentColor", "stroke-width": "1.5", "stroke-linejoin": "round" }),
  );
}

/** The cost figure, or undefined when the session has none. Hover explains how it was made and what it leaves out. */
export function costNode(st: SessionStats): HTMLElement | undefined {
  const text = formatSessionCost(st);
  if (text === undefined) return undefined;
  const el = h("span", { class: "has-tip", tabindex: "0" }, text);
  withTooltip(el, () => describeCost(st));
  return el;
}

/** Usage the session totals leave out (`why` says why); shown only when there is some. */
export function excludedNode(t: UsageTotals | undefined, why: string): HTMLElement | undefined {
  if (!t) return undefined;
  const el = h("span", { class: "has-tip", tabindex: "0" }, `${formatSessionCost(t) ? `${formatSessionCost(t)} · ` : ""}${plural(t)}`);
  withTooltip(el, () => ["Not in the totals above", `${formatUsageTotals(t)} ${why}.`]);
  return el;
}

const plural = (t: UsageTotals) => `${t.responses} ${t.responses === 1 ? "call" : "calls"}`;

export const OTHER_BRANCHES_WHY = "on other branches of this session (rewound or abandoned work)";
export const INHERITED_WHY = "inherited from the parent session this one was forked from";
