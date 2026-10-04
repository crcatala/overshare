/**
 * Session index: every local session as a `SessionSummary`, cached on disk by (path, mtime, size).
 *
 * A plain JSON file is enough: loading it is tens of milliseconds, and filtering/search are
 * in-memory. Only new or changed files are re-read, so after the first run a refresh is one `stat`
 * per file. `buildIndex` blocks until done; `IndexJob` paints from `stat` alone and fills summaries in without blocking.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { defaultRoots, listSessions, type SessionRef, type SessionRoots } from "../resolve.js";
import type { HarnessName } from "../schema.js";
import { PRIVATE_DIR_MODE, PRIVATE_FILE_MODE } from "./private-files.js";
import { summarizeFile, type SessionSummary } from "./summary.js";

export type { SessionSummary } from "./summary.js";

/** Bump when `SessionSummary` changes shape or extraction improves, so stale entries are rebuilt. */
const INDEX_VERSION = 5;

export function indexPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.AGENT_SHARE_INDEX ?? join(env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "agent-share-session", "index.json");
}

interface IndexFile {
  version: number;
  sessions: Record<string, SessionSummary>;
}

function load(path: string): Record<string, SessionSummary> {
  try {
    const file = JSON.parse(readFileSync(path, "utf8")) as IndexFile;
    return file.version === INDEX_VERSION ? file.sessions : {};
  } catch {
    return {};
  }
}

function save(path: string, sessions: Record<string, SessionSummary>): void {
  try {
    mkdirSync(dirname(path), { recursive: true, mode: PRIVATE_DIR_MODE });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: INDEX_VERSION, sessions } satisfies IndexFile), { mode: PRIVATE_FILE_MODE });
    renameSync(tmp, path);
  } catch {
    // The cache is an optimisation; an unwritable cache dir must not break browsing.
  }
}

export interface RefreshProgress {
  done: number;
  total: number;
  /** Files read this run (cache misses). */
  parsed: number;
}

export interface IndexOptions {
  roots?: SessionRoots;
  harnesses?: HarnessName[];
  cachePath?: string;
  /** Called after each cache miss is read, and once at the start (done = cache hits). */
  onProgress?: (p: RefreshProgress, latest?: SessionSummary) => void;
}

/** Stat-only listing (instant): what a UI can show before any file is read. Newest first across harnesses. */
export function listRefs(opts: IndexOptions = {}) {
  const roots = opts.roots ?? defaultRoots();
  // Each harness's list is sorted on its own; merge them so the newest sessions are also the first to be read.
  return (opts.harnesses ?? (["claude-code", "pi"] as const)).flatMap((h) => listSessions(h, roots)).sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** Cache hits, plus the files that still have to be read. Shared by the blocking and the incremental index. */
function plan(opts: IndexOptions) {
  const path = opts.cachePath ?? indexPath();
  const cached = load(path);
  const refs = listRefs(opts);
  const next: Record<string, SessionSummary> = {};
  const stale: SessionRef[] = [];
  for (const ref of refs) {
    const hit = cached[ref.path];
    if (hit && hit.mtimeMs === ref.mtimeMs && hit.size === ref.size) next[ref.path] = hit;
    else stale.push(ref);
  }
  return { path, cached, refs, next, stale };
}

/** Load the cache, (re)summarize changed files, persist, and return summaries newest first. Blocks until done. */
export function buildIndex(opts: IndexOptions = {}): SessionSummary[] {
  const { path, cached, refs, next, stale } = plan(opts);
  let parsed = 0;
  opts.onProgress?.({ done: refs.length - stale.length, total: refs.length, parsed }, undefined);
  for (const ref of stale) {
    try {
      const summary = summarizeFile(ref);
      next[ref.path] = summary;
      parsed++;
      opts.onProgress?.({ done: refs.length - stale.length + parsed, total: refs.length, parsed }, summary);
    } catch {
      // unreadable or vanished: leave it out
    }
  }
  if (parsed > 0 || Object.keys(next).length !== Object.keys(cached).length) save(path, next);
  return Object.values(next).sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** A row for a file that has only been stat-ed: what the list shows until its summary is read. Never persisted. */
function placeholder(ref: SessionRef): SessionSummary {
  return { harness: ref.harness, id: ref.id, path: ref.path, mtimeMs: ref.mtimeMs, size: ref.size, models: [], prompts: 0, calls: 0, tools: {}, subagents: 0, worker: false, promptHead: [], promptTail: [], searchText: "", pending: true };
}

export interface IndexJobOptions extends IndexOptions {
  /** Longest stretch of reading before yielding to the event loop (keys, redraws). One file is never split. Default 20 ms. */
  sliceMs?: number;
  /** Minimum time between cache saves while indexing, so quitting midway keeps progress. Default 2 s. */
  saveEveryMs?: number;
  /** Clock, injectable for tests. */
  now?: () => number;
}

/**
 * The incremental index: `sessions` is complete from the first instant (cache hits as they were, every other
 * file as a stat-only placeholder with `pending` set) and is filled in place, newest first, while the event
 * loop stays free. Each change is announced through `subscribe` once per slice, not once per file.
 * `refresh` lists the files again while the browser is open and queues the new and changed ones the same way.
 * The cache is saved periodically and when the job finishes or is stopped, so quitting midway keeps what was read.
 */
export class IndexJob {
  /** Newest first, mutated in place (rows are replaced when read; unreadable files are removed). */
  readonly sessions: SessionSummary[];
  private readonly path: string;
  private readonly done: Record<string, SessionSummary>;
  private readonly queue: SessionRef[];
  private readonly opts: IndexJobOptions;
  private total: number;
  private readonly sliceMs: number;
  private readonly saveEveryMs: number;
  private readonly now: () => number;
  private readonly listeners = new Set<() => void>();
  private timer?: NodeJS.Immediate;
  private lastSave: number;
  private unsaved = false;

  constructor(opts: IndexJobOptions = {}) {
    const { path, cached, refs, next, stale } = plan(opts);
    this.opts = opts;
    this.path = path;
    this.done = next;
    this.queue = stale;
    this.total = refs.length;
    this.sliceMs = opts.sliceMs ?? 20;
    this.saveEveryMs = opts.saveEveryMs ?? 2_000;
    this.now = opts.now ?? Date.now;
    this.lastSave = this.now();
    this.sessions = refs.map((ref) => next[ref.path] ?? placeholder(ref));
    // Entries for files that no longer exist are dropped from the cache once the job ends (or is stopped).
    this.unsaved = Object.keys(next).length !== Object.keys(cached).length;
    if (this.queue.length === 0) this.finish();
    else this.timer = setImmediate(() => this.slice());
  }

  /** Files whose summary is still to be read, and the total; undefined once the index is complete. */
  progress(): { done: number; total: number } | undefined {
    return this.queue.length === 0 ? undefined : { done: this.total - this.queue.length, total: this.total };
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  /**
   * Look at the files again: sessions that appeared are added as placeholders, ones that grew keep their old row until they are
   * read again, ones that disappeared are removed. Only new and changed files are read (one `stat` per unchanged file), and
   * listeners hear about the new rows at once. `sessions` stays the same array, so whoever holds it sees the change.
   */
  refresh(): void {
    const refs = listRefs(this.opts);
    const shown = new Map(this.sessions.map((s) => [s.path, s]));
    const rows: SessionSummary[] = [];
    const wanted = new Set<string>();
    this.queue.length = 0;
    for (const ref of refs) {
      wanted.add(ref.path);
      const hit = this.done[ref.path];
      if (hit && hit.mtimeMs === ref.mtimeMs && hit.size === ref.size) rows.push(hit);
      else {
        // The row on screen (the old summary, or a placeholder) stays until the new one has been read.
        rows.push(shown.get(ref.path) ?? placeholder(ref));
        this.queue.push(ref);
      }
    }
    for (const path of Object.keys(this.done)) {
      if (!wanted.has(path)) {
        delete this.done[path];
        this.unsaved = true;
      }
    }
    this.total = refs.length;
    this.sessions.splice(0, this.sessions.length, ...rows);
    if (this.queue.length > 0) this.timer ??= setImmediate(() => this.slice());
    else {
      if (this.timer) clearImmediate(this.timer);
      this.finish();
    }
    for (const l of this.listeners) l();
  }

  /** Stop reading and persist what has been read so far. Safe to call repeatedly (and from an `exit` handler). */
  stop(): void {
    if (this.timer) clearImmediate(this.timer);
    this.timer = undefined;
    this.queue.length = 0;
    this.flush();
  }

  private flush(): void {
    if (!this.unsaved) return;
    save(this.path, this.done);
    this.unsaved = false;
    this.lastSave = this.now();
  }

  private finish(): void {
    this.flush();
    this.timer = undefined;
  }

  private slice(): void {
    this.timer = undefined;
    const started = this.now();
    do {
      const ref = this.queue.shift();
      if (!ref) break;
      const at = this.sessions.findIndex((s) => s.path === ref.path);
      try {
        const summary = summarizeFile(ref);
        this.done[ref.path] = summary;
        this.sessions[at] = summary;
        this.unsaved = true;
      } catch {
        // unreadable or vanished: leave it out
        this.sessions.splice(at, 1);
      }
    } while (this.queue.length > 0 && this.now() - started < this.sliceMs);
    if (this.queue.length === 0) this.finish();
    else {
      if (this.unsaved && this.now() - this.lastSave >= this.saveEveryMs) this.flush();
      this.timer = setImmediate(() => this.slice());
    }
    for (const l of this.listeners) l();
  }
}
