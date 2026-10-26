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
 * 3. A scratch folder: a throwaway workspace rather than a project, so many sessions share one place instead of each
 *    getting its own. T3 Code's `…/t3/scratch/<date>-<title>-<hash>` (a thread started without a project) is named by
 *    its title; a folder in the system's temporary folder (`/tmp`, `/var/tmp`, macOS's `/private/var/folders/…/T`,
 *    `$TMPDIR`) by the folder directly in it. Claude Code's own scratchpads there (`claude-<uid>/…`) are just `scratch`.
 *    T3 Code's scratch folders are always scratch. In a temporary folder, a checkout found on disk (step 1) is used only
 *    when it lies inside it: a repository cloned into `/tmp` keeps its name, but a home folder kept in git (dotfiles)
 *    does not swallow the scratchpads under `~/.tmp`.
 * 4. The working directory's last folder.
 *
 * Only the files `git-files.ts` reads safely are touched, and one lookup per directory is made per process.
 */
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { checkoutOf, readText, type Checkout } from "./git-files.js";

export interface ProjectIdentity {
  /** The repository (or, outside one, the folder) the session ran in. */
  name?: string;
  /** A linked worktree's own folder name, when the session ran in one. */
  worktree?: string;
  /** It ran in a scratch folder (a throwaway workspace, see above): `name` is that folder's, tidied. */
  scratch?: boolean;
}

const found = new Map<string, ProjectIdentity>();

/** Lookups made so far are only good for this run: call between runs (and in tests) to look again. */
export function forgetRepos(): void {
  found.clear();
}

export function projectFromCwd(cwd: string | undefined): ProjectIdentity {
  if (!cwd) return {};
  let identity = found.get(cwd);
  if (!identity) found.set(cwd, (identity = identify(cwd)));
  return identity;
}

function identify(cwd: string): ProjectIdentity {
  const t3 = fromT3Scratch(cwd);
  if (t3) return t3;
  const temp = fromTempPath(cwd);
  const checkout = checkoutOf(cwd);
  if (checkout && (!temp || isInside(checkout.top, temp.root))) return fromCheckout(checkout);
  return fromWorktreePath(cwd) ?? temp?.identity ?? { name: segments(cwd).at(-1) };
}

const segments = (path: string) => path.split(/[\\/]/).filter(Boolean);

function fromCheckout(checkout: Checkout): ProjectIdentity {
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

/** Temporary folders, as path segments: the usual ones and this machine's own. */
function tempRoots(): string[][] {
  const roots = [["tmp"], ["var", "tmp"], ["private", "tmp"], ["private", "var", "tmp"]];
  for (const dir of [process.env.TMPDIR, tmpdir()]) if (dir && dir.startsWith("/")) roots.push(segments(dir));
  return roots;
}

const isInside = (path: string, root: string) => segments(path).length > segments(root).length && segments(path).slice(0, segments(root).length).join("/") === segments(root).join("/");

function fromT3Scratch(cwd: string): ProjectIdentity | undefined {
  const parts = segments(cwd);
  const i = parts.findIndex((p, j) => p === "t3" && parts[j + 1] === "scratch" && parts[j + 2]);
  return i >= 0 ? { name: tidyT3Scratch(parts[i + 2]!), scratch: true } : undefined;
}

/** A path in a temporary folder: the deepest one it is in (`$TMPDIR` may be inside another), and its scratch identity. */
function fromTempPath(cwd: string): { root: string; identity: ProjectIdentity } | undefined {
  const parts = segments(cwd);
  // `/private/var/folders/<xx>/<id>/T/<name>`: macOS's temporary folder, whatever the user's `$TMPDIR` says now.
  const mac = parts[0] === "private" && parts[1] === "var" && parts[2] === "folders" && parts[5] === "T" ? 6 : -1;
  const depth = mac >= 0 ? mac : Math.max(-1, ...tempRoots().filter((r) => r.every((p, i) => parts[i] === p)).map((r) => r.length));
  if (depth < 0) return undefined;
  const first = parts[depth];
  return { root: `/${parts.slice(0, depth).join("/")}`, identity: { name: !first || /^claude-\d+$/.test(first) ? "scratch" : first, scratch: true } };
}

/** `2026-10-24-compare-csv-parsers-3f9e1c2a` is `compare-csv-parsers`: the date and hash say nothing new. */
const tidyT3Scratch = (name: string) => name.replace(/^\d{4}-\d{2}-\d{2}-/, "").replace(/-[0-9a-f]{8}$/, "") || name;
