/**
 * Session index: every local session as a `SessionSummary`, cached on disk by (path, mtime, size).
 *
 * A plain JSON file is enough: loading it is tens of milliseconds, and filtering/search are
 * in-memory. Only new or changed files are re-read, so after the first run a refresh is one `stat`
 * per file. `refresh` yields progress so a UI can paint the list from `stat` alone and fill it in.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { defaultRoots, listSessions, type SessionRoots } from "../resolve.js";
import type { HarnessName } from "../schema.js";
import { summarizeFile, type SessionSummary } from "./summary.js";

export type { SessionSummary } from "./summary.js";

/** Bump when `SessionSummary` changes shape or extraction improves, so stale entries are rebuilt. */
const INDEX_VERSION = 3;

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
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: INDEX_VERSION, sessions } satisfies IndexFile));
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

/** Stat-only listing (instant): what a UI can show before any file is read. */
export function listRefs(opts: IndexOptions = {}) {
  const roots = opts.roots ?? defaultRoots();
  return (opts.harnesses ?? (["claude-code", "pi"] as const)).flatMap((h) => listSessions(h, roots));
}

/** Load the cache, (re)summarize changed files, persist, and return summaries newest first. */
export function buildIndex(opts: IndexOptions = {}): SessionSummary[] {
  const path = opts.cachePath ?? indexPath();
  const cached = load(path);
  const refs = listRefs(opts);
  const next: Record<string, SessionSummary> = {};
  const stale = [];
  for (const ref of refs) {
    const hit = cached[ref.path];
    if (hit && hit.mtimeMs === ref.mtimeMs && hit.size === ref.size) next[ref.path] = hit;
    else stale.push(ref);
  }
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
