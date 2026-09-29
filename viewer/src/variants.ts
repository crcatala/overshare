/**
 * Design variants, for evaluating directions side by side (`&variant=<id>` in the link,
 * the settings menu, or `v`/`V`). They share one DOM; each is a stylesheet scoped by
 * `html[data-variant]` plus the few choices below that CSS can't make.
 */
import type { TableStyle } from "./asciitable.ts";

export type VariantId = "classic" | "cli" | "timeline" | "hybrid" | "log";

export interface Variant {
  id: VariantId;
  label: string;
  blurb: string;
  table: TableStyle;
  /** Show thinking text in full (italic) instead of a one-line preview that opens. */
  inlineThinking?: boolean;
}

export const VARIANTS: Variant[] = [
  { id: "classic", label: "classic", blurb: "Minimal blocks: tinted prompts and tool calls, thinking in italics", table: "square", inlineThinking: true },
  { id: "cli", label: "cli", blurb: "Terminal transcript: ● tool lines, └ output, rounded tables", table: "rounded" },
  { id: "timeline", label: "timeline", blurb: "Vertical timeline with a time gutter and docs-style rails", table: "square" },
  { id: "hybrid", label: "hybrid", blurb: "Proportional prose, mono tooling, editorial spacing", table: "minimal" },
  { id: "log", label: "log", blurb: "TUI log: time/role columns, framed panes, statusline", table: "ascii" },
];

export const DEFAULT_VARIANT: VariantId = "classic";

export function findVariant(id: string | null | undefined): Variant | undefined {
  return VARIANTS.find((v) => v.id === id);
}
