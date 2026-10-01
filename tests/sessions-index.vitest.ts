import { chmodSync, mkdirSync, mkdtempSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildIndex } from "../src/sessions/index.js";
import { matches, parseQuery, parseSince, searchSessions } from "../src/sessions/query.js";
import { loadShares, recordShare, sharesFor } from "../src/sessions/shares.js";
import { summarizeRaw, type SessionSummary } from "../src/sessions/summary.js";
import { ccUsage, ClaudeTranscript, PiTranscript } from "./helpers.js";

const ref = (harness: "claude-code" | "pi", id = "abc") => ({ harness, id, path: `/nonexistent/${id}.jsonl`, mtimeMs: 1, size: 1 });

function claudeSession(): string {
  const t = new ClaudeTranscript("sess-1", "/home/tester/work/demo");
  t.meta("ai-title", { aiTitle: "Fix the gist uploader" });
  t.user("fix the gist uploader <system-reminder>hidden</system-reminder>");
  t.assistant("m1", [{ type: "text", text: "on it" }, { type: "tool_use", id: "t1", name: "Bash", input: {} }], ccUsage(10, 5));
  t.toolResult("t1", "ok");
  t.user("<command-name>/review</command-name>\n<command-args>the diff</command-args>");
  t.user("expansion of the review command", { isMeta: true });
  t.user("task done", { origin: { kind: "task-notification" } });
  t.user("looks good, ship it");
  return t.toJsonl();
}

describe("summarizeRaw (claude-code)", () => {
  const s = summarizeRaw(ref("claude-code"), claudeSession());
  it("reads metadata", () => {
    expect(s.title).toBe("Fix the gist uploader");
    expect(s.cwd).toBe("/home/tester/work/demo");
    expect(s.project).toBe("demo");
    expect(s.branch).toBe("main");
    expect(s.models).toEqual(["claude-test-1"]);
    expect(s.calls).toBe(1);
    expect(s.tools).toEqual({ Bash: 1 });
  });
  it("keeps authored prompts only", () => {
    expect(s.promptHead).toEqual(["fix the gist uploader", "/review the diff", "looks good, ship it"]);
    expect(s.prompts).toBe(3);
    expect(s.lastPrompt).toBe("looks good, ship it");
  });
  it("makes prompts searchable", () => {
    expect(s.searchText).toContain("gist uploader");
    expect(s.searchText).not.toContain("hidden");
  });
});

describe("summarizeRaw strips terminal control sequences", () => {
  const evil = "\x1b]52;c;ZXZpbA==\x07\x1b]0;pwned\x07\x1b[2J";
  const everyString = (s: SessionSummary): string[] => [s.title, s.cwd, s.project, s.branch, s.firstPrompt, s.lastPrompt, s.searchText, ...s.models, ...s.promptHead, ...s.promptTail, ...Object.keys(s.tools)].filter((x): x is string => typeof x === "string");
  const CONTROLS = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/;

  it("claude-code: titles, prompts, paths, models and tool names", () => {
    const t = new ClaudeTranscript("sess-evil", `/home/tester/${evil}proj`);
    t.meta("ai-title", { aiTitle: `Title ${evil}` });
    t.user(`ask ${evil} please`);
    t.assistant("m1", [{ type: "tool_use", id: "t1", name: `Bash${evil}`, input: {} }], ccUsage(1, 1));
    const s = summarizeRaw(ref("claude-code"), t.toJsonl());
    expect(s.title).toBe("Title ");
    expect(s.firstPrompt).toBe("ask  please");
    for (const text of everyString(s)) expect(text).not.toMatch(CONTROLS);
  });

  it("pi: titles, prompts and tool names", () => {
    const t = new PiTranscript("pi-evil", `/home/tester/${evil}proj`);
    t.user(`ask ${evil} please`);
    t.assistant([{ type: "toolCall", id: "c1", name: `read${evil}`, arguments: {} }]);
    t.entry("session_info", { name: `Name ${evil}` });
    const s = summarizeRaw(ref("pi"), t.toJsonl());
    expect(s.title).toBe("Name ");
    for (const text of everyString(s)) expect(text).not.toMatch(CONTROLS);
  });
});

describe("summarizeRaw (pi)", () => {
  const t = new PiTranscript("pi-1", "/home/tester/work/piwork");
  t.user("explore the r2 bucket setup");
  t.assistant([{ type: "toolCall", id: "c1", name: "read", arguments: {} }]);
  t.toolResult("c1", "read", "contents");
  t.entry("session_info", { name: "R2 setup" });
  const s = summarizeRaw(ref("pi", "pi-1"), t.toJsonl());
  it("reads metadata", () => {
    expect(s).toMatchObject({ title: "R2 setup", project: "piwork", prompts: 1, calls: 1, tools: { read: 1 }, models: ["test-model"], worker: false });
  });
  it("falls back to the first prompt for the title and flags workers", () => {
    const u = new PiTranscript("pi-2");
    u.user("hello there");
    expect(summarizeRaw(ref("pi", "pi-2"), u.toJsonl()).title).toBe("hello there");
    u.entry("session_info", { name: "subagent-worker-1234-1" });
    expect(summarizeRaw(ref("pi", "pi-2"), u.toJsonl()).worker).toBe(true);
  });
  it("does not title a session after a bare slash command", () => {
    const u = new PiTranscript("pi-3");
    u.user("/model");
    u.user("why is the build slow?");
    expect(summarizeRaw(ref("pi", "pi-3"), u.toJsonl()).title).toBe("why is the build slow?");
    const only = new PiTranscript("pi-4");
    only.user("/model");
    expect(summarizeRaw(ref("pi", "pi-4"), only.toJsonl()).title).toBe("/model");
  });
  it("tolerates a torn last line", () => {
    expect(summarizeRaw(ref("pi", "pi-1"), `${t.toJsonl()}{"type":"message","mess`).prompts).toBe(1);
  });
});

const mk = (over: Partial<SessionSummary>): SessionSummary => ({
  harness: "pi", id: "x", path: "/x", mtimeMs: 1_000, size: 1, models: [], prompts: 1, calls: 1, tools: {}, subagents: 0, worker: false,
  promptHead: [], promptTail: [], searchText: "", ...over,
});

describe("query", () => {
  const NOW = Date.UTC(2026, 8, 30);
  const day = 86_400_000;
  const all = [
    mk({ id: "a", harness: "claude-code", project: "agent-share", title: "Fix gist upload", mtimeMs: NOW - day, searchText: "fix gist upload\nagent-share", models: ["claude-opus-5-5"], tools: { Bash: 2 } }),
    mk({ id: "b", harness: "pi", project: "r2", title: "Bucket policy", mtimeMs: NOW - 10 * day, searchText: "bucket policy\nr2 gist mention" }),
    mk({ id: "c", harness: "pi", project: "r2", title: "subagent-worker-1", worker: true, mtimeMs: NOW, searchText: "gist" }),
  ];
  it("parses tokens and words", () => {
    expect(parseQuery("harness:claude project:r2 gist upload", NOW)).toMatchObject({ harness: "claude-code", project: "r2", words: ["gist", "upload"] });
    expect(parseQuery("repo:r2", NOW).project).toBe("r2"); // the UI calls projects "repos"
    expect(parseSince("7d", NOW)).toBe(NOW - 7 * day);
    expect(parseSince("2026-09-01")).toBe(Date.UTC(2026, 8, 1));
  });
  it("requires every word, ranks title hits first, and hides workers", () => {
    expect(searchSessions(all, "gist").map((s) => s.id)).toEqual(["a", "b"]);
    expect(searchSessions(all, "gist upload").map((s) => s.id)).toEqual(["a"]);
    expect(searchSessions(all, "gist workers:yes").map((s) => s.id)).toContain("c");
  });
  it("filters by harness, recency, model, tool and shared state", () => {
    expect(searchSessions(all, "harness:pi").map((s) => s.id)).toEqual(["b"]);
    expect(searchSessions(all, "since:3d", {}).map((s) => s.id)).toEqual(["a"]);
    expect(searchSessions(all, "model:opus").map((s) => s.id)).toEqual(["a"]);
    expect(searchSessions(all, "tool:Bash").map((s) => s.id)).toEqual(["a"]);
    const shares = { "pi:b": [{ url: "u", mode: "brief" as const, target: "gist" as const, sharedAt: "t" }] };
    expect(searchSessions(all, "shared:yes", shares).map((s) => s.id)).toEqual(["b"]);
    expect(searchSessions(all, "shared:no", shares).map((s) => s.id)).toEqual(["a"]);
    expect(matches(all[0]!, parseQuery("")) ).toBe(true);
  });
});

describe("shares", () => {
  it("appends records and survives a missing or corrupt file", () => {
    const dir = mkdtempSync(join(tmpdir(), "shares-"));
    const path = join(dir, "nested", "shares.json");
    expect(loadShares(path)).toEqual({});
    expect(recordShare("pi", "s1", { url: "u1", mode: "brief", target: "gist", sharedAt: "t1" }, path)).toBe(true);
    recordShare("pi", "s1", { url: "u2", mode: "full", target: "r2", sharedAt: "t2" }, path);
    expect(sharesFor(loadShares(path), "pi", "s1").map((r) => r.url)).toEqual(["u1", "u2"]);
    writeFileSync(path, "{nope");
    expect(loadShares(path)).toEqual({});
  });
});

describe.skipIf(process.platform === "win32")("private state files", () => {
  const mode = (path: string) => statSync(path).mode & 0o777;

  it("shares.json and its directory are not readable by other users", () => {
    const path = join(mkdtempSync(join(tmpdir(), "shares-mode-")), "state", "shares.json");
    recordShare("pi", "s1", { url: "u1", mode: "brief", target: "gist", sharedAt: "t1" }, path);
    expect(mode(path)).toBe(0o600);
    expect(mode(join(path, ".."))).toBe(0o700);
  });

  it("the index cache is written 0600, and a world-readable file from an older version is replaced", () => {
    const dir = mkdtempSync(join(tmpdir(), "idx-mode-"));
    const claude = join(dir, "claude");
    mkdirSync(join(claude, "-home-x"), { recursive: true });
    writeFileSync(join(claude, "-home-x", "sess-1.jsonl"), claudeSession());
    const cachePath = join(dir, "cache", "index.json");
    const roots = { "claude-code": claude, pi: join(dir, "pi") };
    buildIndex({ roots, cachePath });
    expect(mode(cachePath)).toBe(0o600);
    expect(mode(join(cachePath, ".."))).toBe(0o700);
    chmodSync(cachePath, 0o644); // what v0.x wrote
    writeFileSync(join(claude, "-home-x", "sess-2.jsonl"), claudeSession()); // forces a save
    buildIndex({ roots, cachePath });
    expect(mode(cachePath)).toBe(0o600);
  });
});

describe("buildIndex", () => {
  it("summarizes files once and re-reads only changed ones", () => {
    const dir = mkdtempSync(join(tmpdir(), "idx-"));
    const claude = join(dir, "claude");
    mkdirSync(join(claude, "-home-x"), { recursive: true });
    const file = join(claude, "-home-x", "sess-1.jsonl");
    writeFileSync(file, claudeSession());
    const roots = { "claude-code": claude, pi: join(dir, "pi") };
    const cachePath = join(dir, "cache.json");
    let parsed: number[] = [];
    const run = () => buildIndex({ roots, cachePath, onProgress: (p) => parsed.push(p.parsed) });
    expect(run()).toHaveLength(1);
    expect(Math.max(...parsed)).toBe(1);
    parsed = [];
    expect(run()[0]?.title).toBe("Fix the gist uploader");
    expect(Math.max(...parsed)).toBe(0);
    writeFileSync(file, `${claudeSession()}${JSON.stringify({ type: "ai-title", aiTitle: "New title" })}\n`);
    utimesSync(file, new Date(), new Date(Date.now() + 5000));
    parsed = [];
    expect(run()[0]?.title).toBe("New title");
    expect(Math.max(...parsed)).toBe(1);
  });
});
