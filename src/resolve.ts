import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { HARNESSES, HARNESS_NAMES, UnrecognizedFormatError, detectHarnessInLines, type HarnessName } from "./harnesses/index.js";

export type SessionRoots = Record<HarnessName, string>;

export interface SessionRef {
  path: string;
  harness: HarnessName;
  id: string;
  mtimeMs: number;
  size: number;
}

export function defaultRoots(env: NodeJS.ProcessEnv = process.env): SessionRoots {
  const home = homedir();
  return Object.fromEntries(HARNESS_NAMES.map((n) => [n, HARNESSES[n].sessionsRoot(env, home)])) as SessionRoots;
}

function refFor(harness: HarnessName, path: string): SessionRef {
  const st = statSync(path);
  return { path, harness, id: HARNESSES[harness].sessionId(path), mtimeMs: st.mtimeMs, size: st.size };
}

/** All top-level session files for a harness (subagent/sidechain files are excluded), newest first. With `cwd`, only that working directory's. */
export function listSessions(harness: HarnessName, roots: SessionRoots, cwd?: string): SessionRef[] {
  const refs: SessionRef[] = [];
  for (const file of HARNESSES[harness].listFiles(roots[harness], cwd)) {
    try {
      refs.push(refFor(harness, file));
    } catch {
      // vanished between readdir and stat
    }
  }
  return refs.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

export interface ResolveOptions {
  current?: boolean;
  harness?: HarnessName;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  roots?: SessionRoots;
}

/**
 * Resolve a session from a path, a session id / id prefix, or `--current` (the session the running agent names, when
 * its harness can say; otherwise the newest session for the cwd).
 */
export function resolveSession(arg: string | undefined, opts: ResolveOptions = {}): SessionRef {
  const env = opts.env ?? process.env;
  const roots = opts.roots ?? defaultRoots(env);
  const cwd = opts.cwd ?? process.cwd();
  const harnesses: HarnessName[] = opts.harness ? [opts.harness] : HARNESS_NAMES;

  if (arg && existsSync(arg) && statSync(arg).isFile()) {
    return refFor(opts.harness ?? sniffHarness(arg), resolve(arg));
  }
  if (arg) {
    const matches = harnesses.flatMap((h) =>
      listSessions(h, roots).filter((r) => r.id.startsWith(arg) || basename(r.path).startsWith(arg)),
    );
    const unique = [...new Map(matches.map((m) => [m.path, m])).values()];
    if (unique.length === 1) return unique[0]!;
    if (unique.length === 0) throw new Error(`No session matches "${arg}"`);
    throw new Error(`"${arg}" is ambiguous:\n${unique.slice(0, 10).map((m) => `  ${m.harness}  ${m.id}  ${m.path}`).join("\n")}`);
  }
  if (!opts.current) throw new Error("Pass a session path or id, or use --current");

  for (const h of harnesses) {
    const named = HARNESSES[h].currentSession?.(env, roots[h], cwd);
    if (named) return refFor(h, named);
  }
  const candidates = harnesses
    .flatMap((h) => listSessions(h, roots, cwd))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  if (candidates[0]) return candidates[0];
  throw new Error(`No ${opts.harness ?? ""} session found for ${cwd}`.replace("  ", " "));
}

/** The lines of a file, read a block at a time, so a caller that stops early has read only what it needed. */
function* fileLines(path: string): Generator<string> {
  const fd = openSync(path, "r");
  try {
    const decoder = new StringDecoder("utf8");
    const buf = Buffer.alloc(64 * 1024);
    let pending = "";
    for (let n = readSync(fd, buf, 0, buf.length, null); n > 0; n = readSync(fd, buf, 0, buf.length, null)) {
      const parts = (pending + decoder.write(buf.subarray(0, n))).split("\n");
      pending = parts.pop() ?? "";
      yield* parts;
    }
    yield pending + decoder.end();
  } finally {
    closeSync(fd);
  }
}

/**
 * The harness a session file is in: the first line that one of them recognises, however long the lines before it (a
 * pasted file in the first message, a run of bookkeeping lines). A file no harness claims is an error, not a guess.
 */
export function sniffHarness(path: string): HarnessName {
  const found = detectHarnessInLines(fileLines(path));
  if (!found) throw new UnrecognizedFormatError();
  return found;
}
