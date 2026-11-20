import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { readFirstLine, walkFiles } from "../discovery.js";
import { lines, parseLine } from "../summary-kit.js";

/**
 * Where Codex keeps rollouts: `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<local time>-<thread uuid>.jsonl`, and
 * `$CODEX_HOME/archived_sessions/rollout-*.jsonl` after `codex archive`. Folders are by date, not by working directory,
 * so the working directory and whether a rollout is a subagent's come from its first line (`session_meta`).
 */

const ROLLOUT = /^rollout-.+\.jsonl$/;
const THREAD_ID = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

/** The thread id at the end of a rollout's file name (`session_meta.payload.id`). */
export const threadId = (file: string): string => THREAD_ID.exec(basename(file))?.[1] ?? basename(file, ".jsonl");

export interface RolloutHeader {
  /** The thread's id (`session_meta.payload.id`). */
  id?: string;
  /** The thread that spawned this one (a subagent's parent). */
  parent?: string;
  cwd?: string;
  /** A spawned agent's own rollout (`thread_source: "subagent"`): part of its parent, not a session on its own. */
  subagent: boolean;
}

/**
 * The first line, once per file: it is written when the thread starts and never changes. It carries the base
 * instructions (~20 KB), so it is read, not the file; only a line that parses is remembered, since one still being
 * written can be cut.
 */
const headers = new Map<string, RolloutHeader>();
const HEADER_MAX_BYTES = 4 << 20;

export function rolloutHeader(file: string): RolloutHeader | undefined {
  const known = headers.get(file);
  if (known) return known;
  const line = readFirstLine(file, HEADER_MAX_BYTES);
  const e = line === undefined ? undefined : parseLine(line);
  if (e?.type !== "session_meta" || !e.payload || typeof e.payload !== "object") return undefined;
  const p = e.payload;
  const source = p.source;
  const header: RolloutHeader = {
    ...(typeof p.id === "string" && p.id ? { id: p.id } : {}),
    ...(typeof p.parent_thread_id === "string" && p.parent_thread_id ? { parent: p.parent_thread_id } : {}),
    ...(typeof p.cwd === "string" && p.cwd ? { cwd: p.cwd } : {}),
    subagent: p.thread_source === "subagent" || (!!source && typeof source === "object" && "subagent" in source),
  };
  headers.set(file, header);
  return header;
}

/** `sessions/` and, beside it, `archived_sessions/`. */
function rolloutDirs(root: string): string[] {
  const dirs = [root];
  if (basename(resolve(root)) === "sessions") dirs.push(join(dirname(resolve(root)), "archived_sessions"));
  return dirs;
}

/** Every rollout under the root, subagents' too. No root (a caller that names only other harnesses' roots) is none. */
export const allRollouts = (root: string | undefined): string[] => (root ? rolloutDirs(root).flatMap((d) => walkFiles(d, (name) => ROLLOUT.test(name), 4)) : []);

const sameDir = (a: string, b: string): boolean => resolve(a) === resolve(b);

/**
 * Top-level rollouts, optionally only those run in `cwd`. A rollout whose header cannot be read yet (a thread starting
 * this instant) is listed without a working directory: it is never picked for a directory, and is not hidden either.
 */
export function listRollouts(root: string, cwd?: string): string[] {
  return allRollouts(root).filter((f) => {
    const h = rolloutHeader(f);
    if (!h) return cwd === undefined;
    if (h.subagent) return false;
    return cwd === undefined || (h.cwd !== undefined && sameDir(h.cwd, cwd));
  });
}

/**
 * The sessions folder a rollout is filed under: above its `YYYY/MM/DD` folders (whatever the root is called, as with
 * `OVERSHARE_CODEX_SESSIONS`), else a folder named `sessions`, or the one beside `archived_sessions/`.
 */
function sessionsRootOf(file: string): string | undefined {
  const day = dirname(resolve(file));
  const month = dirname(day);
  const year = dirname(month);
  if (/^\d{2}$/.test(basename(day)) && /^\d{2}$/.test(basename(month)) && /^\d{4}$/.test(basename(year))) return dirname(year);
  let dir = day;
  for (let i = 0; i < 6; i++) {
    const name = basename(dir);
    if (name === "sessions") return dir;
    if (name === "archived_sessions") return join(dirname(dir), "sessions");
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return undefined;
}

/**
 * The rollouts of the agents a thread spawned, and of the agents they spawned, found by the `parent_thread_id` in each
 * header (they are filed by date like any thread, not beside the parent). Order: breadth first, by file name.
 */
export function subagentRollouts(file: string): string[] {
  const root = sessionsRootOf(file);
  const self = rolloutHeader(file)?.id ?? threadId(file);
  if (!root) return [];
  const children = new Map<string, string[]>();
  for (const f of allRollouts(root).sort()) {
    const h = rolloutHeader(f);
    if (!h?.parent || f === file) continue;
    children.set(h.parent, [...(children.get(h.parent) ?? []), f]);
  }
  const out: string[] = [];
  const seen = new Set<string>([self]);
  const queue = [self];
  while (queue.length) {
    for (const f of children.get(queue.shift()!) ?? []) {
      const id = rolloutHeader(f)?.id ?? threadId(f);
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(f);
      queue.push(id);
    }
  }
  return out;
}

/** What the Codex adapter reads beside a rollout. */
export interface CodexSidecar {
  /** The thread's name in `session_index.jsonl` (set when the user renames it). */
  title?: string;
}

/** `$CODEX_HOME`, found from a rollout's path: the nearest folder above it with a `session_index.jsonl`. */
function codexHomeOf(file: string): string | undefined {
  let dir = dirname(resolve(file));
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, "session_index.jsonl"))) return dir;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return undefined;
}

/** `session_index.jsonl` as id -> name, read again only when the file changes. The last line for an id wins. */
const indexes = new Map<string, { stamp: string; names: Map<string, string> }>();

function threadNames(home: string): Map<string, string> {
  const path = join(home, "session_index.jsonl");
  let stamp: string;
  try {
    const st = statSync(path);
    stamp = `${st.mtimeMs}:${st.size}`;
  } catch {
    return new Map();
  }
  const cached = indexes.get(path);
  if (cached?.stamp === stamp) return cached.names;
  const names = new Map<string, string>();
  try {
    for (const line of lines(readFileSync(path, "utf8"))) {
      const e = parseLine(line);
      if (typeof e?.id === "string" && typeof e.thread_name === "string" && e.thread_name.trim()) names.set(e.id, e.thread_name.trim());
    }
  } catch {
    // Unreadable: no names.
  }
  indexes.set(path, { stamp, names });
  return names;
}

export function loadCodexSidecar(file: string): CodexSidecar {
  const home = codexHomeOf(file);
  const title = home ? threadNames(home).get(threadId(file)) : undefined;
  return title ? { title } : {};
}

/** Clear the in-process caches (tests). */
export function resetCodexCaches(): void {
  headers.clear();
  indexes.clear();
}
