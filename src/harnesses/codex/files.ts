import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { readFirstLine, walkFiles } from "../discovery.js";
import { SessionTooLargeError, isCompressed, maxSessionBytes, readTranscript, readTranscriptBytes } from "../limits.js";
import { lines, parseLine } from "../summary-kit.js";

/**
 * Where Codex keeps rollouts: `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<local time>-<thread uuid>.jsonl`, and
 * `$CODEX_HOME/archived_sessions/rollout-*.jsonl` after `codex archive`. Folders are by date, not by working directory,
 * so the working directory and whether a rollout is a subagent's come from its first line (`session_meta`).
 *
 * Two more shapes (codex-rs `rollout/src/rollout_file_name.rs`, `compression.rs`):
 * - an idle rollout is recompressed to `rollout-*.jsonl.zst` (the plain file is preferred while both exist);
 * - a reverted thread continues in `rollout-<time>-<thread>_<rollout id>.jsonl`, whose header's `history_base` names
 *   the rollout (by its rollout id) and the byte offset its kept history ends at. The thread is one session: its
 *   newest rollout, with that history read in front of it.
 */

const ROLLOUT = /^rollout-.+\.jsonl(\.zst)?$/;
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const NAME = new RegExp(`(${UUID})(?:_(${UUID}))?\\.jsonl(?:\\.zst)?$`, "i");

/** The thread id in a rollout's file name (`session_meta.payload.id`). */
export const threadId = (file: string): string => NAME.exec(basename(file))?.[1] ?? basename(file).replace(/\.jsonl(\.zst)?$/, "");

/** The rollout id in a file name: the thread id, or the one after `_` in a continuation file. */
export const rolloutId = (file: string): string => {
  const m = NAME.exec(basename(file));
  return m ? (m[2] ?? m[1]!) : threadId(file);
};

export interface RolloutHeader {
  /** The thread's id (`session_meta.payload.id`). */
  id?: string;
  /** The thread that spawned this one (a subagent's parent). */
  parent?: string;
  cwd?: string;
  /** A spawned agent's own rollout (`thread_source: "subagent"`): part of its parent, not a session on its own. */
  subagent: boolean;
  /** History kept from another rollout (a reverted thread's earlier one, or a fork's parent): its id and where it ends. */
  base?: { rollout: string; endByte: number };
}

/** The first line of a compressed rollout: the file is decompressed whole (within the size limit) to find it. */
function compressedFirstLine(file: string): string | undefined {
  try {
    const text = readTranscript(file);
    const end = text.indexOf("\n");
    return end < 0 ? text : text.slice(0, end);
  } catch {
    return undefined;
  }
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
  const line = isCompressed(file) ? compressedFirstLine(file) : readFirstLine(file, HEADER_MAX_BYTES);
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
  const base = p.history_base;
  if (base && typeof base === "object" && typeof base.thread_id === "string" && typeof base.end_byte_offset === "number" && base.end_byte_offset >= 0) {
    header.base = { rollout: base.thread_id, endByte: base.end_byte_offset };
  }
  headers.set(file, header);
  return header;
}

/** `sessions/` and, beside it, `archived_sessions/`. */
function rolloutDirs(root: string): string[] {
  const dirs = [root];
  if (basename(resolve(root)) === "sessions") dirs.push(join(dirname(resolve(root)), "archived_sessions"));
  return dirs;
}

/**
 * Every rollout under the root, subagents' too, each once: a `.jsonl.zst` is left out while its plain `.jsonl` is
 * there (Codex keeps both only while switching). No root (a caller naming only other harnesses' roots) is none.
 */
export function allRollouts(root: string | undefined): string[] {
  if (!root) return [];
  const files = rolloutDirs(root).flatMap((d) => walkFiles(d, (name) => ROLLOUT.test(name), 4));
  const plain = new Set(files.filter((f) => !isCompressed(f)));
  return files.filter((f) => !isCompressed(f) || !plain.has(f.slice(0, -".zst".length)));
}

const fileSize = (f: string): number => {
  try {
    return statSync(f).size;
  } catch {
    return 0;
  }
};

const mtime = (f: string): number => {
  try {
    return statSync(f).mtimeMs;
  } catch {
    return 0;
  }
};

const sameDir = (a: string, b: string): boolean => resolve(a) === resolve(b);

/**
 * Top-level rollouts, optionally only those run in `cwd`. A rollout whose header cannot be read yet (a thread starting
 * this instant) is listed without a working directory: it is never picked for a directory, and is not hidden either.
 */
/** `rollout-<YYYY-MM-DDTHH-MM-SS>-…`: when a rollout was started, sortable as text. */
const startedAt = (f: string): string => /^rollout-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})/.exec(basename(f))?.[1] ?? "";

/**
 * The rollout a thread continues in, among several (a reverted thread): the one started last by its file name, then
 * the one written last, then by name, so the choice never depends on the order files are listed in.
 */
export function newestRollout(files: readonly string[]): string | undefined {
  return [...files].sort((a, b) => startedAt(b).localeCompare(startedAt(a)) || mtime(b) - mtime(a) || basename(b).localeCompare(basename(a)))[0];
}

/** Each thread's current rollout (see `newestRollout`): the others are history it reads. */
function currentRollouts(files: readonly string[]): string[] {
  const byThread = new Map<string, string[]>();
  for (const f of files) byThread.set(threadId(f), [...(byThread.get(threadId(f)) ?? []), f]);
  const current = new Set([...byThread.values()].map((list) => newestRollout(list)!));
  return files.filter((f) => current.has(f));
}

export function listRollouts(root: string, cwd?: string): string[] {
  // The current rollout of each thread first, then the filters: an older rollout of a thread never stands in for it.
  return currentRollouts(allRollouts(root)).filter((f) => {
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

/** History a rollout keeps from another one, oldest first: the text and whether it is another thread's (a fork's parent). */
export interface CodexHistory {
  raw: string;
  /** From another thread: inherited, not this session's own spend. */
  inherited: boolean;
}

/** What the Codex adapter reads beside a rollout. */
export interface CodexSidecar {
  /** The thread's name in `session_index.jsonl` (set when the user renames it). */
  title?: string;
  /** The history a continuation (or fork) rollout keeps from earlier rollouts, oldest first. */
  history?: CodexHistory[];
}

/** The first `end` bytes of a rollout (decompressed if need be). */
function prefixOf(file: string, end: number): string {
  // `end` is a byte offset: cut the bytes, then decode (a cut in decoded text would count characters).
  if (isCompressed(file)) return readTranscriptBytes(file).subarray(0, end).toString("utf8");
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(Math.min(end, statSync(file).size));
    const n = readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/**
 * The history a rollout's header says it keeps from other rollouts (`history_base`), following the chain back,
 * oldest first. A rollout that cannot be found ends the chain; the whole is held to the size limit.
 */
export function rolloutHistory(file: string): CodexHistory[] {
  const root = sessionsRootOf(file);
  const self = rolloutHeader(file);
  if (!root || !self?.base) return [];
  const byRollout = new Map(allRollouts(root).map((f) => [rolloutId(f), f]));
  const out: CodexHistory[] = [];
  const seen = new Set<string>([rolloutId(file)]);
  // One budget for the rollout and all the history it keeps, checked before each prefix is read.
  const limit = maxSessionBytes();
  let total = isCompressed(file) ? 0 : fileSize(file);
  for (let base = self.base; base && !seen.has(base.rollout); ) {
    seen.add(base.rollout);
    const source = byRollout.get(base.rollout);
    if (!source) break;
    total += base.endByte;
    if (total > limit) throw new SessionTooLargeError(total, limit);
    const raw = prefixOf(source, base.endByte);
    const header = rolloutHeader(source);
    out.unshift({ raw, inherited: !!header?.id && !!self.id && header.id !== self.id });
    base = header?.base as typeof base;
  }
  return out;
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
  const history = rolloutHistory(file);
  return { ...(title ? { title } : {}), ...(history.length ? { history } : {}) };
}

/** The sidecar's cache key: the title, and the rollouts whose history is read with it. */
export function codexSidecarKey(file: string): string {
  const home = codexHomeOf(file);
  const title = home ? (threadNames(home).get(threadId(file)) ?? "") : "";
  if (!rolloutHeader(file)?.base) return title;
  // The rollouts whose history is read, as found now: one that appears (or changes) reads the session again.
  return [title, ...historySources(file).map((f) => `${f}:${mtime(f)}`)].join("\u0000");
}

/** The rollouts a rollout's `history_base` chain resolves to, newest first. */
function historySources(file: string): string[] {
  const root = sessionsRootOf(file);
  if (!root) return [];
  const byRollout = new Map(allRollouts(root).map((f) => [rolloutId(f), f]));
  const out: string[] = [];
  const seen = new Set<string>([rolloutId(file)]);
  for (let base = rolloutHeader(file)?.base; base && !seen.has(base.rollout); base = rolloutHeader(out.at(-1)!)?.base) {
    seen.add(base.rollout);
    const source = byRollout.get(base.rollout);
    if (!source) break;
    out.push(source);
  }
  return out;
}

/** Clear the in-process caches (tests). */
export function resetCodexCaches(): void {
  headers.clear();
  indexes.clear();
}
