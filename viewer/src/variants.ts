/**
 * Design variants, for evaluating directions side by side (`&ui=<id>` in the link,
 * the settings menu, or `v`/`V`). They share one DOM; each is a stylesheet scoped by
 * `html[data-variant]` plus the few choices below that CSS can't make.
 */
import type { TableStyle } from "./asciitable.ts";

export type VariantId = "classic" | "cli" | "log";

export interface Variant {
  id: VariantId;
  label: string;
  blurb: string;
  table: TableStyle;
  /**
   * Show thinking text in full (italic) instead of a one-line preview that opens. This
   * renders every thinking block's markdown up front, like replies: measured on a
   * 128-turn session with 124 blocks of ~3k characters, about +80ms (~0.7ms a block).
   * If long real sessions make that noticeable, render them as they scroll into view.
   */
  inlineThinking?: boolean;
}

export const VARIANTS: Variant[] = [
  { id: "classic", label: "classic", blurb: "Minimal blocks: tinted prompts and tool calls, thinking in italics", table: "square", inlineThinking: true },
  { id: "cli", label: "cli", blurb: "Terminal transcript: ● tool lines, └ output, rounded tables", table: "rounded" },
  { id: "log", label: "log", blurb: "TUI log: time/role columns, framed panes, statusline", table: "ascii" },
];

export const DEFAULT_VARIANT: VariantId = "classic";

export function findVariant(id: string | null | undefined): Variant | undefined {
  return VARIANTS.find((v) => v.id === id);
}
