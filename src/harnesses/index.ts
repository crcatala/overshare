import { readFileSync, statSync } from "node:fs";
import { HARNESS_NAMES, type HarnessName } from "./meta.js";
import { claudeCode } from "./claude-code/index.js";
import { codex } from "./codex/index.js";
import { pi } from "./pi/index.js";
import type { AdapterOptions, AdapterResult, SubagentFileInput } from "./shared.js";
import type { Harness } from "./types.js";

export { HARNESS_NAMES, type HarnessName } from "./meta.js";
export type { AdapterOptions, AdapterResult, SubagentFileInput } from "./shared.js";
export { UnsupportedFormatError } from "./shared.js";
export type { Harness } from "./types.js";

/**
 * Every harness we read. Typed by `HarnessName`, so a name added to `meta.ts` without a descriptor here is a type
 * error. To support a new harness: a folder `src/harnesses/<name>/` with its descriptor, an entry in `meta.ts`, a line here.
 */
export const HARNESSES: Record<HarnessName, Harness> = { "claude-code": claudeCode, pi, codex };

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

/** What a harness keeps beside a session's transcript (see `Harness.sidecar`), or undefined when it keeps nothing there. */
export function loadSidecar(harness: HarnessName, sessionPath: string): unknown {
  return known(harness)?.sidecar?.load(sessionPath);
}

/** Default for `maxSessionBytes`: well under the longest string Node can hold, which a whole-file read needs. */
const DEFAULT_MAX_SESSION_MB = 256;

/** The largest transcript overshare reads into memory: `OVERSHARE_MAX_SESSION_MB` megabytes, else 256. */
export function maxSessionBytes(env: NodeJS.ProcessEnv = process.env): number {
  const mb = Number(env.OVERSHARE_MAX_SESSION_MB);
  return (Number.isFinite(mb) && mb > 0 ? mb : DEFAULT_MAX_SESSION_MB) * 1024 * 1024;
}

const megabytes = (bytes: number): string => `${Math.ceil(bytes / (1024 * 1024)).toLocaleString("en-US")} MB`;

/** A transcript larger than `maxSessionBytes`. The message is fixed text and sizes: it never quotes the file or its path. */
export class SessionTooLargeError extends Error {
  constructor(
    readonly size: number,
    readonly limit: number,
  ) {
    super(`The session file is ${megabytes(size)}, more than the ${megabytes(limit)} overshare reads (set OVERSHARE_MAX_SESSION_MB to raise it)`);
    this.name = "SessionTooLargeError";
  }
}

/** Throws `SessionTooLargeError` when a file of `size` bytes is over the limit. */
export function checkSessionSize(size: number, env: NodeJS.ProcessEnv = process.env): void {
  const limit = maxSessionBytes(env);
  if (size > limit) throw new SessionTooLargeError(size, limit);
}

/**
 * Everything a parse of the session at `path` needs from disk: the transcript, within the size limit, and what its
 * harness keeps beside it (subagent transcripts, sidecar data). The one place the CLI and the browser read a session.
 */
export function readSession(harness: HarnessName, path: string, env: NodeJS.ProcessEnv = process.env): { raw: string; options: AdapterOptions } {
  checkSessionSize(statSync(path).size, env);
  const raw = readFileSync(path, "utf8");
  const subagentFiles = loadSubagentFiles(harness, path);
  const sidecar = loadSidecar(harness, path);
  return { raw, options: { ...(subagentFiles ? { subagentFiles } : {}), ...(sidecar !== undefined ? { sidecar } : {}) } };
}
