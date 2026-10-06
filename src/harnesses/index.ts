import { HARNESS_NAMES, type HarnessName } from "./meta.js";
import { claudeCode } from "./claude-code/index.js";
import { pi } from "./pi/index.js";
import type { AdapterOptions, AdapterResult, SubagentFileInput } from "./shared.js";
import type { Harness } from "./types.js";

export { HARNESS_NAMES, type HarnessName } from "./meta.js";
export type { AdapterOptions, AdapterResult, SubagentFileInput } from "./shared.js";
export type { Harness } from "./types.js";

/**
 * Every harness we read. Typed by `HarnessName`, so a name added to `meta.ts` without a descriptor here is a type
 * error. To support a new harness: a folder `src/harnesses/<name>/` with its descriptor, an entry in `meta.ts`, a line here.
 */
export const HARNESSES: Record<HarnessName, Harness> = { "claude-code": claudeCode, pi };

/** The descriptors in display order. */
export const harnesses = (): Harness[] => HARNESS_NAMES.map((n) => HARNESSES[n]);

/**
 * The harness a transcript is in, by its first lines. A harness's `detect` has to be specific to its own format: the
 * first one that says yes wins.
 */
export function detectHarness(raw: string): HarnessName | undefined {
  return detectHarnessInLines(raw.split("\n", 50));
}

/** `detectHarness` over any source of lines, so a caller reading a file can go on until a line says what it is. */
export function detectHarnessInLines(lines: Iterable<string>): HarnessName | undefined {
  for (const line of lines) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const match = harnesses().find((h) => h.detect(entry));
    if (match) return match.name;
  }
  return undefined;
}

/** The transcript is not in a format we read. The message is fixed text: it never quotes the transcript. */
export class UnrecognizedFormatError extends Error {
  constructor() {
    super(`Could not detect the transcript format (supported: ${HARNESS_NAMES.join(", ")})`);
    this.name = "UnrecognizedFormatError";
  }
}

/** A name that crossed a boundary (a job request, a cache file) may be anything: only an own key of `HARNESSES` is a harness. */
const known = (name: string | undefined): Harness | undefined => (name !== undefined && Object.hasOwn(HARNESSES, name) ? HARNESSES[name as HarnessName] : undefined);

export function parseSession(raw: string, harness?: HarnessName, options?: AdapterOptions): AdapterResult {
  const h = known(harness ?? detectHarness(raw));
  if (!h) throw new UnrecognizedFormatError();
  return h.parse(raw, options);
}

/** The subagent transcripts that sit beside a session file, for a harness that keeps them there (none otherwise). */
export function loadSubagentFiles(harness: HarnessName, sessionPath: string): SubagentFileInput[] | undefined {
  return known(harness)?.subagents?.load(sessionPath);
}
