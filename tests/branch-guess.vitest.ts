import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { forgetReflogs, guessBranch } from "../src/sessions/branch.js";
import { summarizeRaw, withBranchGuess, type SessionSummary } from "../src/sessions/summary.js";
import { PiTranscript } from "./helpers.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "branch-guess-"));
  forgetReflogs();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const T = (iso: string) => Date.parse(iso);
const sha = "a".repeat(40);
const line = (iso: string, msg: string) => `${sha} ${"b".repeat(40)} Test User <t@example.com> ${Math.floor(T(iso) / 1000)} +0000\t${msg}`;

/** A repository with just the files the guess reads: HEAD and its reflog. */
function repo(name: string, head: string, reflog: string[] = []): string {
  const dir = join(root, name);
  mkdirSync(join(dir, ".git", "logs"), { recursive: true });
  writeFileSync(join(dir, ".git", "HEAD"), head);
  writeFileSync(join(dir, ".git", "logs", "HEAD"), reflog.join("\n") + "\n");
  return dir;
}

describe("guessBranch", () => {
  const log = [
    line("2026-09-01T10:00:00Z", "commit (initial): start"),
    line("2026-09-10T10:00:00Z", "checkout: moving from main to feat/a"),
    line("2026-09-20T10:00:00Z", "checkout: moving from feat/a to feat/b"),
    line("2026-09-25T10:00:00Z", "commit: work"),
  ];

  it("is the target of the last checkout before the session", () => {
    const cwd = repo("r", "ref: refs/heads/feat/b\n", log);
    expect(guessBranch(cwd, T("2026-09-12T00:00:00Z"))).toBe("feat/a");
    expect(guessBranch(cwd, T("2026-09-22T00:00:00Z"))).toBe("feat/b");
    expect(guessBranch(cwd, T("2026-10-01T00:00:00Z"))).toBe("feat/b");
  });

  it("is the source of the first checkout when the session is older than all of them", () => {
    expect(guessBranch(repo("r", "ref: refs/heads/feat/b\n", log), T("2026-09-05T00:00:00Z"))).toBe("main");
  });

  it("is the current branch for a repo that never switched", () => {
    expect(guessBranch(repo("r", "ref: refs/heads/develop\n", [line("2026-09-01T10:00:00Z", "commit (initial): x")]), T("2026-09-05T00:00:00Z"))).toBe("develop");
  });

  it("says nothing when HEAD is detached and there is no checkout to go by, or the checkout was onto a commit", () => {
    expect(guessBranch(repo("d", `${sha}\n`), T("2026-09-05T00:00:00Z"))).toBeUndefined();
    const onto = repo("c", "ref: refs/heads/main\n", [line("2026-09-10T10:00:00Z", `checkout: moving from main to ${"c".repeat(40)}`)]);
    expect(guessBranch(onto, T("2026-09-12T00:00:00Z"))).toBeUndefined();
  });

  it("finds the repository from a subdirectory", () => {
    const cwd = repo("r", "ref: refs/heads/main\n");
    mkdirSync(join(cwd, "packages", "app"), { recursive: true });
    expect(guessBranch(join(cwd, "packages", "app"), 0)).toBe("main");
  });

  it("follows a worktree's .git file to its own HEAD and reflog", () => {
    const main = repo("main-checkout", "ref: refs/heads/main\n");
    const gitdir = join(main, ".git", "worktrees", "wt");
    mkdirSync(join(gitdir, "logs"), { recursive: true });
    writeFileSync(join(gitdir, "HEAD"), "ref: refs/heads/fix/wt\n");
    writeFileSync(join(gitdir, "logs", "HEAD"), line("2026-09-10T10:00:00Z", "checkout: moving from main to fix/wt") + "\n");
    const wt = join(root, "wt");
    mkdirSync(wt);
    writeFileSync(join(wt, ".git"), `gitdir: ${gitdir}\n`);
    expect(guessBranch(wt, T("2026-09-12T00:00:00Z"))).toBe("fix/wt");
    expect(guessBranch(wt, T("2026-09-01T00:00:00Z"))).toBe("main");
  });

  it("does not borrow a repository above a working directory that is gone (a deleted worktree)", () => {
    const outer = repo("outer", "ref: refs/heads/main\n");
    expect(guessBranch(join(outer, "deleted-worktree"), 0)).toBeUndefined();
  });

  it("is undefined for no directory, a relative one, or no repository", () => {
    expect(guessBranch(undefined, 0)).toBeUndefined();
    expect(guessBranch("relative/dir", 0)).toBeUndefined();
    const plain = join(root, "plain");
    mkdirSync(plain);
    expect(guessBranch(plain, 0)).toBeUndefined();
  });

  it("returns only a plain branch name: control sequences from a hostile ref are dropped", () => {
    const evil = "\x1b]52;c;ZXZpbA==\x07\x1b[2Jnice";
    const cwd = repo("e", `ref: refs/heads/${evil}\n`);
    const guess = guessBranch(cwd, 0)!;
    expect(guess).toBe("nice");
  });

  it("cuts a very long name", () => {
    expect(guessBranch(repo("l", `ref: refs/heads/${"x".repeat(500)}\n`), 0)!.length).toBe(100);
  });

  it("reads each repository once per run", () => {
    const cwd = repo("r", "ref: refs/heads/main\n", log);
    expect(guessBranch(cwd, T("2026-09-12T00:00:00Z"))).toBe("feat/a");
    writeFileSync(join(cwd, ".git", "logs", "HEAD"), "");
    expect(guessBranch(cwd, T("2026-09-12T00:00:00Z"))).toBe("feat/a"); // from the first read
    forgetReflogs();
    expect(guessBranch(cwd, T("2026-09-12T00:00:00Z"))).toBe("main");
  });
});

describe("withBranchGuess", () => {
  const base = (over: Partial<SessionSummary> = {}): SessionSummary => ({
    harness: "pi", id: "x", path: "/p.jsonl", mtimeMs: T("2026-09-12T00:00:00Z"), size: 1, models: [], prompts: 0, calls: 0, tools: {}, subagents: 0, worker: false, promptHead: [], promptTail: [], searchText: "title", ...over,
  });

  it("marks a guessed branch as one and makes it searchable", () => {
    const cwd = repo("r", "ref: refs/heads/feat/b\n", [line("2026-09-10T10:00:00Z", "checkout: moving from main to Feat/A")]);
    const s = withBranchGuess(base({ cwd, endedAt: "2026-09-12T00:00:00Z" }));
    expect(s).toMatchObject({ branch: "Feat/A", branchGuess: true });
    expect(s.searchText).toBe("title\nfeat/a");
  });

  it("leaves a branch the transcript recorded alone", () => {
    const cwd = repo("r", "ref: refs/heads/other\n");
    const s = withBranchGuess(base({ cwd, branch: "recorded" }));
    expect(s.branch).toBe("recorded");
    expect(s.branchGuess).toBeUndefined();
  });

  it("leaves a session with no working directory, or no answer, as it is", () => {
    const s = base();
    expect(withBranchGuess(s)).toBe(s);
    const t = base({ cwd: join(root, "nowhere") });
    expect(withBranchGuess(t)).toBe(t);
  });

  it("works on what summarizeRaw makes of a pi transcript (pi records no branch)", () => {
    const cwd = repo("pi-work", "ref: refs/heads/main\n", [line("2026-09-10T10:00:00Z", "checkout: moving from main to spike/x")]);
    const t = new PiTranscript("pi-1", cwd);
    t.user("hello");
    const s = summarizeRaw({ harness: "pi", id: "pi-1", path: "/p.jsonl", mtimeMs: Date.now(), size: 1 }, t.toJsonl());
    expect(s.branch).toBeUndefined();
    expect(withBranchGuess({ ...s, endedAt: "2026-09-12T00:00:00Z" })).toMatchObject({ branch: "spike/x", branchGuess: true });
  });
});
