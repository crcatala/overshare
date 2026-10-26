/**
 * The repository a session ran in, named after its main checkout rather than the folder it happened to run in.
 *
 * A transcript records only the working directory. Its last folder is a poor name in two common cases: a session in a
 * subfolder (`…/acme-api/packages/core` is `core`) and one in a linked git worktree, whose folder is named by whatever
 * made it (`~/.local/share/t3/worktrees/acme-api/t3-6c1e90ab` is `t3-6c1e90ab`). So, in order:
 *
 * 1. The checkout on disk. Its top folder names a plain repository. A linked worktree's `.git` file points into the main
 *    repository's `.git/worktrees/<name>`, whose `commondir` leads back to that `.git`: the folder holding it names the
 *    repository, and the worktree keeps its own folder name as `worktree`.
 * 2. A worktree that is gone (most are removed once merged) leaves nothing on disk to follow, and git prunes its entry in
 *    the main repository. Its path still says where it came from when it follows a known layout:
 *    `…/worktrees/<repo>/<name>` (T3 Code, herdr and the like), `<repo>/.claude/worktrees/<name>` (Claude Code),
 *    `<repo>/.worktrees/<name>` (a common folder kept inside the repository) and `~/.codex/worktrees/<hash>/<repo>`
 *    (Codex).
 * 3. The working directory's last folder.
 *
 * Only the files `git-files.ts` reads safely are touched, and one lookup per directory is made per process.
 */
import { basename, dirname, join, resolve } from "node:path";
import { checkoutOf, readText } from "./git-files.js";

export interface ProjectIdentity {
  /** The repository (or, outside one, the folder) the session ran in. */
  name?: string;
  /** A linked worktree's own folder name, when the session ran in one. */
  worktree?: string;
}

const found = new Map<string, ProjectIdentity>();

/** Lookups made so far are only good for this run: call between runs (and in tests) to look again. */
export function forgetRepos(): void {
  found.clear();
}

export function projectFromCwd(cwd: string | undefined): ProjectIdentity {
  if (!cwd) return {};
  let identity = found.get(cwd);
  if (!identity) found.set(cwd, (identity = fromCheckout(cwd) ?? fromWorktreePath(cwd) ?? { name: segments(cwd).at(-1) }));
  return identity;
}

const segments = (path: string) => path.split(/[\\/]/).filter(Boolean);

function fromCheckout(cwd: string): ProjectIdentity | undefined {
  const checkout = checkoutOf(cwd);
  if (!checkout) return undefined;
  const top = basename(checkout.top);
  if (!checkout.linked) return { name: top };
  // A submodule's `.git` file points to `.git/modules/<name>`, which has no `commondir`: it is a repository of its own.
  const common = readText(join(checkout.gitDir, "commondir"), 4_096)?.trim();
  if (!common) return { name: top };
  const commonDir = resolve(checkout.gitDir, common);
  // `<repo>/.git` normally; a bare repository is `<repo>.git` (or just `<repo>`).
  const name = basename(commonDir) === ".git" ? basename(dirname(commonDir)) : basename(commonDir).replace(/\.git$/, "");
  return { name: name || top, worktree: top };
}

function fromWorktreePath(cwd: string): ProjectIdentity | undefined {
  const parts = segments(cwd);
  for (let i = parts.length - 1; i > 0; i--) {
    if (parts[i] !== "worktrees" && parts[i] !== ".worktrees") continue;
    const parent = parts[i - 1];
    const [first, second] = [parts[i + 1], parts[i + 2]];
    // `.git/worktrees/<name>` is git's own bookkeeping, not a checkout.
    if (parent === ".git" || !first) continue;
    // Inside the repository: `<repo>/.claude/worktrees/<name>` and `<repo>/.worktrees/<name>`.
    if (parent === ".claude") {
      if (i >= 2) return { name: parts[i - 2], worktree: first };
      continue;
    }
    if (parts[i] === ".worktrees") return { name: parent, worktree: first };
    if (!second) continue;
    if (parent === ".codex") return { name: second, worktree: first };
    return { name: first, worktree: second };
  }
  return undefined;
}
