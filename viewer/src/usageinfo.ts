/** Cost and out-of-scope usage figures with the tooltips that say what they mean; used by the header and the token rail. */
import { describeCost, formatSessionCost, formatUsageTotals } from "../../src/format.ts";
import type { SessionStats, UsageTotals } from "../../src/schema.ts";
import { h, withTooltip } from "./dom.ts";

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
  const el = h("span", { class: "has-tip", tabindex: "0" }, `${t.cost !== undefined ? `${formatSessionCost({ cost: t.cost })} · ` : ""}${plural(t)}`);
  withTooltip(el, () => ["Not in the totals above", `${formatUsageTotals(t)} ${why}.`]);
  return el;
}

const plural = (t: UsageTotals) => `${t.responses} ${t.responses === 1 ? "call" : "calls"}`;

export const OTHER_BRANCHES_WHY = "on other branches of this session (rewound or abandoned work)";
export const INHERITED_WHY = "inherited from the parent session this one was forked from";
