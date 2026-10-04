import type { HarnessName } from "./meta.js";
import type { AdapterOptions, AdapterResult, SubagentFileInput } from "./shared.js";
import type { Collector } from "./summary-kit.js";

/**
 * Everything that is specific to one harness and reads the machine or a native transcript. Generic code (the
 * pipeline, the session index, the CLI, the browser) goes through `HARNESSES` in `index.ts` and never asks which
 * harness it has: where a behaviour exists for only some harnesses it is an optional member here, and the code that
 * needs it checks for the member. What the viewer needs (labels, flags) is plain data in `meta.ts` instead.
 */
export interface Harness {
  name: HarnessName;

  /** Where its sessions live: the directory `listFiles` starts from. */
  sessionsRoot(env: NodeJS.ProcessEnv, home: string): string;
  /**
   * Top-level session files under `root` (a subagent's own transcript is not one), in any order. With `cwd`, only the
   * sessions that were run in that working directory; this is how `--current` finds the newest one.
   */
  listFiles(root: string, cwd?: string): string[];
  /** The id a user types to pick `file`. */
  sessionId(file: string): string;

  /** True when `firstEntry` (a parsed line near the top of a transcript) looks like this harness's format. */
  detect(firstEntry: Record<string, unknown>): boolean;
  /** Native transcript -> `NormalizedSession`. Pure: reads nothing from disk (see `subagents.load`). */
  parse(raw: string, options?: AdapterOptions): AdapterResult;
  /** The browser's index: feed the lines of a transcript into `c` in one pass, without a full parse. */
  summarize(raw: string, c: Collector): void;

  /** The path of the session the agent running this process says it is in (`--current` prefers it over the newest one). */
  currentSession?(env: NodeJS.ProcessEnv, root: string, cwd: string): string | undefined;
  /** Subagents that keep their transcripts in files beside the session's. */
  subagents?: {
    /** Read them (the adapter stays pure and is handed the result as `AdapterOptions.subagentFiles`). */
    load(sessionPath: string): SubagentFileInput[];
    /** How many there are, without reading them. */
    count(sessionPath: string, id: string): number;
  };
  /** JSON files holding this harness's own login credentials, so their values are redacted if they leak into a transcript. */
  credentialFiles?(env: NodeJS.ProcessEnv, home: string): string[];
}
