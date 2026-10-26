/**
 * Reading a checkout's git files without a `git` subprocess, for the branch guess (`branch.ts`) and the repository a
 * session ran in (`repo.ts`). The working directory comes from the transcript, so it is untrusted: every read is
 * bounded and non-blocking. Between them they read `.git` (or the `gitdir:` pointer in it), and in the git directory
 * `HEAD`, `logs/HEAD` and `commondir`.
 */
import { closeSync, constants, fstatSync, openSync, readSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

/**
 * A small text file, or undefined. Only a regular file is read, and never in a way that can wait: the path comes from a
 * transcript, and a FIFO there (named `.git`, `HEAD` or `logs/HEAD`) would block a plain `readFileSync` for good, freezing
 * the whole browser. So the file is opened non-blocking, checked on the open descriptor (no race with a swap after a
 * `stat`), and read in a bounded way: more than `max` bytes means "too big", not "read it all".
 */
export const readText = (path: string, max = 1_000_000): string | undefined => {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    if (!fstatSync(fd).isFile()) return undefined;
    const buf = Buffer.alloc(max + 1);
    let n = 0;
    for (let got = 1; got > 0 && n <= max; n += got) got = readSync(fd, buf, n, max + 1 - n, null);
    return n > max ? undefined : buf.toString("utf8", 0, n);
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
};

export interface Checkout {
  /** The checkout's top folder: the one holding `.git`. */
  top: string;
  /** `top/.git` itself, or the folder a linked worktree's (or submodule's) `.git` file points to. */
  gitDir: string;
  /** `.git` is a file pointing elsewhere. */
  linked: boolean;
}

/** The checkout that contains `cwd`, or undefined when `cwd` is not in one or no longer exists. */
export function checkoutOf(cwd: string): Checkout | undefined {
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
      if (st.isDirectory()) return { top: dir, gitDir: dotGit, linked: false };
      const pointer = /^gitdir:\s*(.+)\s*$/m.exec(readText(dotGit, 4_096) ?? "")?.[1];
      if (pointer) return { top: dir, gitDir: resolve(dir, pointer), linked: true };
      return undefined;
    } catch {
      // no .git here: look one level up
    }
    if (dirname(dir) === dir) return undefined;
  }
}
