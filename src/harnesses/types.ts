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
  /**
   * The working directory `file` was run in, when the harness knows it without reading the transcript (Codex: its
   * header line, already read by `listFiles`). `list` shows it; harnesses whose folders are named after the
   * directory leave it out.
   */
  sessionCwd?(file: string): string | undefined;

  /** True when `firstEntry` (a parsed line near the top of a transcript) looks like this harness's format. */
  detect(firstEntry: Record<string, unknown>): boolean;
  /** Native transcript -> `NormalizedSession`. Pure: reads nothing from disk (see `subagents.load`, `sidecar.load`). */
  parse(raw: string, options?: AdapterOptions): AdapterResult;
  /** The browser's index: feed the lines of a transcript into `c` in one pass, without a full parse. `sidecar` as for `parse`. */
  summarize(raw: string, c: Collector, sidecar?: unknown): void;

  /** The path of the session the agent running this process says it is in (`--current` prefers it over the newest one). */
  currentSession?(env: NodeJS.ProcessEnv, root: string, cwd: string): string | undefined;
  /** Subagents that keep their transcripts in files beside the session's. */
  subagents?: {
    /** Read them (the adapter stays pure and is handed the result as `AdapterOptions.subagentFiles`). */
    load(sessionPath: string): SubagentFileInput[];
    /** How many there are, without reading them. */
    count(sessionPath: string, id: string): number;
  };
  /**
   * What a session keeps outside its transcript file (Codex: a renamed title in `session_index.jsonl`; Antigravity: the
   * conversation's database). Read here, by whoever reads the transcript, and handed to `parse` (as
   * `AdapterOptions.sidecar`) and `summarize`, so both stay pure. The value is the harness's own plain data.
   */
  sidecar?: {
    /** `summary`: for the browser's index, which needs less (a harness may skip reading what only a share uses). */
    load(sessionPath: string, purpose?: "parse" | "summary"): unknown;
    /**
     * Cheap, and different whenever `load` would return something else: the browser's index keeps a session's summary
     * while the transcript file and this key are unchanged.
     */
    key(sessionPath: string): string;
  };
  /** JSON files holding this harness's own login credentials, so their values are redacted if they leak into a transcript. */
  credentialFiles?(env: NodeJS.ProcessEnv, home: string): string[];
}
