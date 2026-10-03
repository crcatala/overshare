/**
 * Best guess of the git branch a session ran on, for sessions whose transcript does not say (pi records no branch;
 * a Claude Code session may lack `gitBranch`).
 *
 * No `git` subprocess (hundreds of sessions would mean hundreds of spawns): the repo's own files are read instead.
 * HEAD's reflog (`logs/HEAD`) lists every `checkout: moving from A to B` with a timestamp, so the branch at a given
 * moment is the target of the last checkout before it. A session older than every checkout still on record ran on the
 * source of the first one after it. A repo with no checkouts at all is on its current branch (`HEAD`).
 *
 * It stays a guess, and callers must say so: the reflog expires (90 days by default), a branch can be deleted or
 * renamed, and a checkout made by something other than `git checkout`/`git switch` is not in it.
 *
 * The working directory comes from the transcript, so it is untrusted: only these four things are read (`.git`,
 * a `gitdir:` pointer in it, and `HEAD` / `logs/HEAD` there), and only a plain branch name comes back.
 */
import { readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { stripControls } from "../sanitize.js";

interface Checkout {
  at: number;
  from: string;
  to: string;
}

interface Reflog {
  /** Oldest first. */
  checkouts: Checkout[];
  /** The branch HEAD names now; undefined when detached or unreadable. */
  head?: string;
}

const MAX_REFLOG_BYTES = 4_000_000;
const MAX_BRANCH_CHARS = 100;
const SHA = /^[0-9a-f]{7,40}$/;
const CHECKOUT = /^\S+ \S+ .*? (\d{9,11}) [+-]\d{4}\tcheckout: moving from (\S+) to (\S+)$/;

const readText = (path: string, max = 1_000_000): string | undefined => {
  try {
    if (statSync(path).size > max) return undefined;
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
};

/** The git directory of the checkout that contains `cwd`: `.git` itself, or what a worktree's `.git` file points to. */
function gitDirOf(cwd: string): string | undefined {
  if (!isAbsolute(cwd)) return undefined;
  try {
    // A directory that is gone (a deleted worktree) must not resolve to some unrelated repository above it.
    if (!statSync(cwd).isDirectory()) return undefined;
  } catch {
    return undefined;
  }
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    const dotGit = join(dir, ".git");
    try {
      const st = statSync(dotGit);
      if (st.isDirectory()) return dotGit;
      const pointer = /^gitdir:\s*(.+)\s*$/m.exec(readText(dotGit, 4_096) ?? "")?.[1];
      if (pointer) return resolve(dir, pointer);
      return undefined;
    } catch {
      // no .git here: look one level up
    }
    if (dirname(dir) === dir) return undefined;
  }
}

const branchName = (ref: string): string | undefined => {
  const name = stripControls(ref).trim().replace(/^refs\/heads\//, "");
  return name && name !== "HEAD" && !SHA.test(name) ? name.slice(0, MAX_BRANCH_CHARS) : undefined;
};

function readReflog(gitDir: string): Reflog {
  const head = /^ref:\s*refs\/heads\/(.+)\s*$/m.exec(readText(join(gitDir, "HEAD"), 4_096) ?? "")?.[1];
  const checkouts: Checkout[] = [];
  for (const line of (readText(join(gitDir, "logs", "HEAD"), MAX_REFLOG_BYTES) ?? "").split("\n")) {
    const m = CHECKOUT.exec(line);
    if (m) checkouts.push({ at: Number(m[1]) * 1000, from: m[2]!, to: m[3]! });
  }
  return { checkouts, head };
}

/** One read of each repository per process: `IndexJob` asks once per session, and a repo has dozens. */
const reflogs = new Map<string, Reflog>();

/** The reflog read so far is only good for this run: call between runs (and in tests) to read the files again. */
export function forgetReflogs(): void {
  reflogs.clear();
}

/** The branch the repo at `cwd` was most likely on at `atMs`, or undefined when there is no way to tell. */
export function guessBranch(cwd: string | undefined, atMs: number): string | undefined {
  if (!cwd || !Number.isFinite(atMs)) return undefined;
  const gitDir = gitDirOf(cwd);
  if (!gitDir) return undefined;
  let log = reflogs.get(gitDir);
  if (!log) reflogs.set(gitDir, (log = readReflog(gitDir)));
  const { checkouts } = log;
  const before = checkouts.filter((c) => c.at <= atMs).at(-1);
  if (before) return branchName(before.to);
  if (checkouts[0]) return branchName(checkouts[0].from);
  return log.head ? branchName(log.head) : undefined;
}
