/**
 * Design variants, for evaluating directions side by side (`&variant=<id>` in the link,
 * or the switcher at the bottom of the page). They share one DOM; each is a stylesheet
 * scoped by `html[data-variant]` plus the few choices below that CSS can't make.
 */
import type { TableStyle } from "./asciitable.ts";

export type VariantId = "cli" | "timeline" | "hybrid" | "log";

export interface Variant {
  id: VariantId;
  label: string;
  blurb: string;
  table: TableStyle;
  /** Token charts: DOM bars, or text sparklines built from block characters. */
  chart: "bars" | "blocks";
}

export const VARIANTS: Variant[] = [
  { id: "cli", label: "cli", blurb: "Terminal transcript: ● tool lines, └ output, rounded tables", table: "rounded", chart: "bars" },
  { id: "timeline", label: "timeline", blurb: "Vertical timeline with a time gutter and docs-style rails", table: "square", chart: "bars" },
  { id: "hybrid", label: "hybrid", blurb: "Proportional prose, mono tooling, editorial spacing", table: "minimal", chart: "bars" },
  { id: "log", label: "log", blurb: "TUI log: time/role columns, panes, statusline, text sparklines", table: "ascii", chart: "blocks" },
];

export const DEFAULT_VARIANT: VariantId = "cli";

export function findVariant(id: string | null | undefined): Variant | undefined {
  return VARIANTS.find((v) => v.id === id);
}
