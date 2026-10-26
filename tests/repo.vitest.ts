import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { forgetRepos, projectFromCwd } from "../src/sessions/repo.js";
import { summarizeRaw } from "../src/sessions/summary.js";
import { PiTranscript } from "./helpers.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "repo-"));
  forgetRepos();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** A plain checkout: a folder with a `.git` folder. */
function repo(...path: string[]): string {
  const dir = join(root, ...path);
  mkdirSync(join(dir, ".git"), { recursive: true });
  return dir;
}

/** A linked worktree of `gitCommon` (a `.git` folder or a bare repository), as `git worktree add` lays it out. */
function worktree(gitCommon: string, ...path: string[]): string {
  const name = path.at(-1)!;
  const gitdir = join(gitCommon, "worktrees", name);
  mkdirSync(gitdir, { recursive: true });
  writeFileSync(join(gitdir, "commondir"), "../..\n");
  const dir = join(root, ...path);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".git"), `gitdir: ${gitdir}\n`);
  return dir;
}

describe("projectFromCwd", () => {
  it("names a checkout after its top folder, from any folder inside it", () => {
    const dir = repo("work", "overshare");
    mkdirSync(join(dir, "packages", "core"), { recursive: true });
    expect(projectFromCwd(dir)).toEqual({ name: "overshare" });
    expect(projectFromCwd(join(dir, "packages", "core"))).toEqual({ name: "overshare" });
  });

  it("names a linked worktree after its main checkout, wherever the worktree lives", () => {
    const main = repo("work", "acme-api");
    const wt = worktree(join(main, ".git"), "elsewhere", "t3-6c1e90ab");
    mkdirSync(join(wt, "hub"));
    expect(projectFromCwd(wt)).toEqual({ name: "acme-api", worktree: "t3-6c1e90ab" });
    expect(projectFromCwd(join(wt, "hub"))).toEqual({ name: "acme-api", worktree: "t3-6c1e90ab" });
  });

  it("names a worktree of a bare repository after the repository, without .git", () => {
    const bare = join(root, "srv", "tools.git");
    mkdirSync(bare, { recursive: true });
    expect(projectFromCwd(worktree(bare, "wt", "feature-x"))).toEqual({ name: "tools", worktree: "feature-x" });
  });

  it("names a submodule after its own folder", () => {
    const sub = join(repo("work", "parent"), "vendor", "lib");
    const gitdir = join(root, "work", "parent", ".git", "modules", "lib");
    mkdirSync(gitdir, { recursive: true });
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, ".git"), `gitdir: ${gitdir}\n`);
    expect(projectFromCwd(sub)).toEqual({ name: "lib" });
  });

  it.each([
    ["T3 Code", "/home/u/.local/share/t3/worktrees/acme-api/t3-6c1e90ab/hub", { name: "acme-api", worktree: "t3-6c1e90ab" }],
    ["herdr", "/home/u/.herdr/worktrees/web-app/worktree-quiet-lake-0a1b", { name: "web-app", worktree: "worktree-quiet-lake-0a1b" }],
    ["Claude Code", "/home/u/work/overshare/.claude/worktrees/fix-thing/src", { name: "overshare", worktree: "fix-thing" }],
    ["a repository's own .worktrees", "/home/u/work/overshare/.worktrees/fix-thing/src", { name: "overshare", worktree: "fix-thing" }],
    ["Codex", "/home/u/.codex/worktrees/a1b2/overshare/src", { name: "overshare", worktree: "a1b2" }],
  ])("reads the repository from a removed %s worktree's path", (_tool, cwd, expected) => {
    expect(projectFromCwd(cwd)).toEqual(expected);
  });

  it("falls back to the last folder of a path that is gone and follows no worktree layout", () => {
    expect(projectFromCwd("/home/u/work/deleted-project")).toEqual({ name: "deleted-project" });
    expect(projectFromCwd("/home/u/worktrees/only-one")).toEqual({ name: "only-one" });
    expect(projectFromCwd("/srv/repo/.git/worktrees/x")).toEqual({ name: "x" });
    expect(projectFromCwd("/.claude/worktrees/x")).toEqual({ name: "x" });
    expect(projectFromCwd(undefined)).toEqual({});
  });

  it("prefers what is on disk over the path's layout", () => {
    const main = repo("work", "real-name");
    expect(projectFromCwd(worktree(join(main, ".git"), "worktrees", "other-name", "wt"))).toEqual({ name: "real-name", worktree: "wt" });
  });

  it.each([
    ["a T3 Code thread without a project", "/home/u/.local/share/t3/scratch/2026-10-24-compare-csv-parsers-3f9e1c2a", "compare-csv-parsers"],
    ["a T3 Code scratch folder whose name has no date or hash", "/home/u/.local/share/t3/scratch/notes", "notes"],
    ["a folder in /tmp", "/tmp/try-a-lib/sub", "try-a-lib"],
    ["a folder in /var/tmp", "/var/tmp/try-it", "try-it"],
    ["macOS's temporary folder", "/private/var/folders/x1/abc123/T/try-it", "try-it"],
    ["macOS's temporary folder as $TMPDIR spells it", "/var/folders/x1/abc123/T/try-it/sub", "try-it"],
    ["a Claude Code scratchpad", "/tmp/claude-1000/-home-u-work-x-0f3c/scratchpad", "scratch"],
    ["the temporary folder itself", "/tmp", "scratch"],
  ])("marks %s as scratch", (_what, cwd, name) => {
    expect(projectFromCwd(cwd)).toEqual({ name, scratch: true });
  });

  it("reads $TMPDIR as a temporary folder", () => {
    const before = process.env.TMPDIR;
    process.env.TMPDIR = "/home/u/.tmp";
    try {
      expect(projectFromCwd("/home/u/.tmp/claude-1000/x/scratchpad")).toEqual({ name: "scratch", scratch: true });
    } finally {
      if (before === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = before;
    }
  });

  it("takes a $TMPDIR inside macOS's temporary folder as the deeper of the two", () => {
    const before = process.env.TMPDIR;
    process.env.TMPDIR = "/var/folders/x1/abc123/T/tool-tmp";
    try {
      expect(projectFromCwd("/var/folders/x1/abc123/T/tool-tmp/try-it")).toEqual({ name: "try-it", scratch: true });
    } finally {
      if (before === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = before;
    }
  });

  it("keeps a repository cloned into a temporary folder, but not one the temporary folder is inside", () => {
    // `root` is in the temporary folder: a checkout made there is a project.
    expect(projectFromCwd(repo("clone"))).toEqual({ name: "clone" });
    // A home folder in git with its own temporary folder: the scratchpad under it is not that repository.
    const home = repo("home");
    const scratch = join(home, ".tmp", "quick");
    mkdirSync(scratch, { recursive: true });
    const before = process.env.TMPDIR;
    process.env.TMPDIR = join(home, ".tmp");
    try {
      expect(projectFromCwd(scratch)).toEqual({ name: "quick", scratch: true });
    } finally {
      if (before === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = before;
    }
  });

  it("is what the session list shows as the project", () => {
    const t = new PiTranscript("pi-1", "/home/u/.local/share/t3/worktrees/acme-api/t3-6c1e90ab");
    t.user("hello");
    expect(summarizeRaw({ harness: "pi", id: "pi-1", path: "/p.jsonl", mtimeMs: Date.now(), size: 1 }, t.toJsonl()).project).toBe("acme-api");
  });
});
