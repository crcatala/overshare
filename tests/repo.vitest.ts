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

  it("is what the session list shows as the project", () => {
    const t = new PiTranscript("pi-1", "/home/u/.local/share/t3/worktrees/acme-api/t3-6c1e90ab");
    t.user("hello");
    expect(summarizeRaw({ harness: "pi", id: "pi-1", path: "/p.jsonl", mtimeMs: Date.now(), size: 1 }, t.toJsonl()).project).toBe("acme-api");
  });
});
