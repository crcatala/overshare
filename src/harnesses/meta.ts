/**
 * What the viewer and the terminal UI need to know about each harness, as plain data (browser-safe, no Node imports;
 * the viewer bundle imports it through `schema.ts`). The code that reads a harness's files lives in its own folder
 * (`src/harnesses/<name>/`) and is registered in `index.ts`.
 *
 * Adding a harness starts here: one entry, then `npm run typecheck` lists what is still missing (a descriptor in
 * `index.ts`, anything that switches on `HarnessName`).
 */

/** Colours the terminal UI can draw a harness tag in (keys of `st` in `browse/kit.ts`). */
export type HarnessColor = "yellow" | "magenta" | "cyan" | "green" | "blue" | "red";

export interface HarnessMeta {
  /** Display name: the viewer's "agent" field, the browser's group heading and preview line. */
  label: string;
  /** What the browser's harness chip shows. */
  short: string;
  /** Short tag for the browser's session list; padded to two columns. */
  tag: string;
  color: HarnessColor;
  /** Other words `harness:<word>` in a search accepts (the name itself always works). */
  aliases: readonly string[];
  /**
   * Its Anthropic cache entries live 5 minutes unless the transcript shows 1-hour writes. Harnesses without it are
   * assumed to refresh or extend the entry, so a long idle gap alone is not read as a likely miss (see `cache.ts`).
   */
  shortCacheTtl?: true;
  /**
   * The viewer adds up subagent usage on each turn: the adapter read it from the subagents' own transcripts. Without
   * it the per-launch figures are best effort and are shown, not summed.
   */
  sumsSubagentUsage?: true;
  /**
   * User text in its transcripts may be a template or skill expansion rather than what the user typed, so `prompts`
   * mode needs a prompt to be marked `authored`. The value is the advice shown when some are not.
   */
  promptsNeedAuthoredProof?: string;
}

export const HARNESS_META = {
  "claude-code": {
    label: "Claude Code",
    short: "claude",
    tag: "CC",
    color: "yellow",
    aliases: ["claude", "cc"],
    shortCacheTtl: true,
    sumsSubagentUsage: true,
  },
  pi: {
    label: "pi",
    short: "pi",
    tag: "π",
    color: "magenta",
    aliases: [],
    promptsNeedAuthoredProof:
      "Install or reload the updated pi share extension before submitting new idle prompts; existing inputs or queued expansions cannot be recovered reliably.",
  },
} as const satisfies Record<string, HarnessMeta>;

/** The harnesses we read. A share's `harness.name` is this type once the viewer has opened it, but may be anything before. */
export type HarnessName = keyof typeof HARNESS_META;

/** In display order: the order of the browser's harness filter and of `list`. */
export const HARNESS_NAMES = Object.keys(HARNESS_META) as HarnessName[];

/** The meta of a harness this build knows, or undefined for any other string (a share from a tool we do not read, `__proto__`, ...). */
export function metaOf(name: string | undefined): HarnessMeta | undefined {
  return name !== undefined && Object.hasOwn(HARNESS_META, name) ? (HARNESS_META as Record<string, HarnessMeta>)[name] : undefined;
}

/** Display name; an unknown harness shows as its own name. */
export const harnessLabel = (name: string): string => metaOf(name)?.label ?? name;
