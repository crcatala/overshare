import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildIndex, IndexJob } from "../src/sessions/index.js";
import { matches, parseQuery, parseSince, searchSessions } from "../src/sessions/query.js";
import { forgetShare, parseShareRef } from "../src/publish/index.js";
import { loadShares, recordShare, removeShares, sharesFor, type ShareRecord } from "../src/sessions/shares.js";
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
    mk({ id: "a", harness: "claude-code", project: "overshare", title: "Fix gist upload", mtimeMs: NOW - day, searchText: "fix gist upload\novershare", models: ["claude-opus-5-5"], tools: { Bash: 2 } }),
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
    expect(searchSessions(all, parseQuery("since:3d", NOW), {}).map((s) => s.id)).toEqual(["a"]);
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

describe("forgetting deleted shares", () => {
  const GIST = "5260b8cf9b1baae31a40717ac1ab5f08";
  const gist = (id = GIST): ShareRecord => ({ url: `https://overshare.link/s/#octo/${id}`, mode: "brief", target: "gist", sharedAt: "t1" });
  const r2 = (id = "AbCdEfGhIjKlMnOpQrStUv"): ShareRecord => ({ url: `https://overshare.link/s/#r2:${id}`, mode: "full", target: "r2", sharedAt: "t2" });
  const fresh = () => join(mkdtempSync(join(tmpdir(), "shares-rm-")), "shares.json");

  it("removeShares drops matching records, keeps the rest, and removes emptied keys", () => {
    const path = fresh();
    recordShare("pi", "s1", gist(), path);
    recordShare("pi", "s1", r2(), path);
    recordShare("claude-code", "s2", gist(), path); // the same share recorded under another session
    recordShare("pi", "s3", r2("ZyXwVuTsRqPoNmLkJiHgFe"), path);
    expect(removeShares((r) => r.target === "gist", path)).toBe(true);
    const all = loadShares(path);
    expect(sharesFor(all, "pi", "s1").map((r) => r.target)).toEqual(["r2"]);
    expect(Object.keys(all).sort()).toEqual(["pi:s1", "pi:s3"]);
  });

  it("removeShares is a quiet no-op for a missing file or an unknown share", () => {
    const path = fresh();
    expect(removeShares(() => true, path)).toBe(true);
    recordShare("pi", "s1", gist(), path);
    const before = readFileSync(path, "utf8");
    expect(removeShares(() => false, path)).toBe(true);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("removeShares reports a corrupt or unwritable file instead of throwing", () => {
    const path = fresh();
    writeFileSync(path, "{nope");
    expect(removeShares(() => true, path)).toBe(false);
    expect(readFileSync(path, "utf8")).toBe("{nope");
    const blocked = join(path, "..", "dir-as-file");
    mkdirSync(blocked);
    expect(removeShares(() => true, blocked)).toBe(false);
  });

  it.each([
    ["viewer link", `https://overshare.link/s/#octo/${GIST}`],
    ["gist url", `https://gist.github.com/octo/${GIST}`],
    ["bare gist id", GIST],
    ["gist: prefix", `gist:${GIST}`],
  ])("forgetShare matches a gist share given as %s", (_name, input) => {
    const path = fresh();
    recordShare("pi", "s1", gist(), path);
    recordShare("pi", "s1", r2(), path);
    recordShare("pi", "other", gist("0123456789abcdef0123456789abcdef"), path);
    expect(forgetShare(parseShareRef(input), path)).toBe(true);
    expect(sharesFor(loadShares(path), "pi", "s1").map((r) => r.target)).toEqual(["r2"]);
    expect(sharesFor(loadShares(path), "pi", "other")).toHaveLength(1);
  });

  it.each([
    ["viewer link", "https://overshare.link/s/#r2:AbCdEfGhIjKlMnOpQrStUv", "gist"],
    ["r2: prefix", "r2:AbCdEfGhIjKlMnOpQrStUv", "gist"],
    ["bare id with --target r2", "AbCdEfGhIjKlMnOpQrStUv", "r2"],
  ] as const)("forgetShare matches an r2 share given as %s", (_name, input, fallback) => {
    const path = fresh();
    recordShare("pi", "s1", r2(), path);
    recordShare("pi", "s1", gist(), path);
    expect(forgetShare(parseShareRef(input, fallback), path)).toBe(true);
    expect(sharesFor(loadShares(path), "pi", "s1").map((r) => r.target)).toEqual(["gist"]);
  });

  it("forgetShare matches a gist id regardless of case, but r2 ids stay case-sensitive", () => {
    const path = fresh();
    recordShare("pi", "s1", gist(), path);
    recordShare("pi", "s1", r2(), path);
    expect(forgetShare(parseShareRef(`https://overshare.link/s/#octo/${GIST.toUpperCase()}`), path)).toBe(true);
    expect(forgetShare(parseShareRef("r2:abcdefghijklmnopqrstuv"), path)).toBe(true);
    expect(sharesFor(loadShares(path), "pi", "s1").map((r) => r.target)).toEqual(["r2"]);
  });

  // Root ignores directory permissions, so the write would succeed.
  it.skipIf(process.getuid?.() === 0)("removeShares keeps the file and reports failure when the replacement cannot be written", () => {
    const path = fresh();
    recordShare("pi", "s1", gist(), path);
    const before = readFileSync(path, "utf8");
    const dir = dirname(path);
    chmodSync(dir, 0o500); // the temp file cannot be created
    try {
      expect(removeShares(() => true, path)).toBe(false);
    } finally {
      chmodSync(dir, 0o700);
    }
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("forgetShare leaves records with an unparseable url alone", () => {
    const path = fresh();
    recordShare("pi", "s1", { url: "not a link", mode: "brief", target: "gist", sharedAt: "t" }, path);
    expect(forgetShare({ target: "gist", id: GIST }, path)).toBe(true);
    expect(sharesFor(loadShares(path), "pi", "s1")).toHaveLength(1);
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

  it("the index cache is written 0600, and an existing world-readable file is replaced", () => {
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

describe("IndexJob (incremental index)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  /** `n` Claude sessions whose mtimes make sess-0 the newest. */
  function setup(n: number) {
    const dir = mkdtempSync(join(tmpdir(), "idx-job-"));
    const claude = join(dir, "claude");
    mkdirSync(join(claude, "-home-x"), { recursive: true });
    const files = Array.from({ length: n }, (_, i) => {
      const file = join(claude, "-home-x", `sess-${i}.jsonl`);
      const t = new ClaudeTranscript(`sess-${i}`, "/home/tester/work/demo");
      t.meta("ai-title", { aiTitle: `Title ${i}` });
      t.user(`prompt ${i}`);
      writeFileSync(file, t.toJsonl());
      utimesSync(file, new Date(2026, 0, 1, 0, 0, 0), new Date(2026, 0, 1, 12, n - i));
      return file;
    });
    const cachePath = join(dir, "cache.json");
    const roots = { "claude-code": claude, pi: join(dir, "pi") };
    const cachedIds = () => Object.keys(JSON.parse(readFileSync(cachePath, "utf8")).sessions).map((p) => p.match(/sess-(\d+)/)![1]);
    return { dir, files, cachePath, roots, cachedIds };
  }
  /** Let `n` slices run (the job yields with setImmediate between slices). */
  const slices = async (n: number) => {
    for (let i = 0; i < n; i++) await vi.advanceTimersToNextTimerAsync();
  };
  const titles = (job: IndexJob) => job.sessions.map((s) => s.title ?? (s.pending ? "…" : "?"));

  it("lists every session at once as stat-only placeholders, newest first, and fills them in as slices run", async () => {
    const { roots, cachePath } = setup(3);
    const job = new IndexJob({ roots, cachePath, sliceMs: 0 });
    expect(job.sessions.map((s) => s.id)).toEqual(["sess-0", "sess-1", "sess-2"]);
    expect(job.sessions.every((s) => s.pending && s.size > 0 && s.harness === "claude-code")).toBe(true);
    expect(job.progress()).toEqual({ done: 0, total: 3 });
    const seen: string[][] = [];
    job.subscribe(() => seen.push(titles(job)));
    await vi.runAllTimersAsync();
    expect(seen).toEqual([["Title 0", "…", "…"], ["Title 0", "Title 1", "…"], ["Title 0", "Title 1", "Title 2"]]);
    expect(job.sessions.some((s) => s.pending)).toBe(false);
    expect(job.progress()).toBeUndefined();
  });

  it("reads the globally newest sessions first, whichever harness they belong to", async () => {
    const dir = mkdtempSync(join(tmpdir(), "idx-job-mixed-"));
    const claude = join(dir, "claude", "-home-x");
    const pi = join(dir, "pi", "--home-x--");
    mkdirSync(claude, { recursive: true });
    mkdirSync(pi, { recursive: true });
    // Oldest to newest: claude-0, claude-1, claude-2, pi-0 (newest of all), so pi must not wait behind the Claude files.
    const at = (minutes: number) => new Date(2026, 0, 1, 12, minutes);
    const put = (file: string, text: string, minutes: number) => {
      writeFileSync(file, text);
      utimesSync(file, at(minutes), at(minutes));
    };
    for (let i = 0; i < 3; i++) put(join(claude, `claude-${i}.jsonl`), new ClaudeTranscript(`claude-${i}`, "/home/tester/work/demo").user("hi").toJsonl(), i);
    put(join(pi, "2026-01-01T12-30-00-000Z_pi-0.jsonl"), new PiTranscript("pi-0").toJsonl(), 30);
    const job = new IndexJob({ roots: { "claude-code": join(dir, "claude"), pi: join(dir, "pi") }, cachePath: join(dir, "cache.json"), sliceMs: 0 });
    expect(job.sessions.map((x) => x.id)).toEqual(["pi-0", "claude-2", "claude-1", "claude-0"]);
    await slices(1);
    expect(job.sessions.filter((x) => !x.pending).map((x) => x.id)).toEqual(["pi-0"]);
    await vi.runAllTimersAsync();
    expect(job.sessions.some((x) => x.pending)).toBe(false);
  });

  it("reads several files per slice while the time budget allows, and notifies once per slice", async () => {
    const { roots, cachePath } = setup(4);
    let t = 0;
    const job = new IndexJob({ roots, cachePath, sliceMs: 10, now: () => (t += 1) });
    let notified = 0;
    job.subscribe(() => notified++);
    await vi.runAllTimersAsync();
    expect(job.sessions.every((s) => !s.pending)).toBe(true);
    expect(notified).toBeLessThan(4);
    expect(notified).toBeGreaterThan(0);
  });

  it("persists only read summaries, periodically, so a quit mid-index keeps progress", async () => {
    const { roots, cachePath, cachedIds } = setup(5);
    const job = new IndexJob({ roots, cachePath, sliceMs: 0, saveEveryMs: 0 });
    await slices(2);
    expect(cachedIds().sort()).toEqual(["0", "1"]);
    expect(readFileSync(cachePath, "utf8")).not.toContain("pending");
    job.stop(); // the user quits
    await vi.runAllTimersAsync();
    expect(job.sessions.filter((s) => !s.pending)).toHaveLength(2); // nothing more was read
    // The next run re-reads only what was not read before the quit.
    const parsed: number[] = [];
    expect(buildIndex({ roots, cachePath, onProgress: (p) => parsed.push(p.parsed) })).toHaveLength(5);
    expect(Math.max(...parsed)).toBe(3);
  });

  it("stop() saves reads that the periodic save has not reached yet", async () => {
    const { roots, cachePath, cachedIds } = setup(4);
    const job = new IndexJob({ roots, cachePath, sliceMs: 0, saveEveryMs: 60_000 });
    await slices(3);
    expect(() => readFileSync(cachePath)).toThrow(); // nothing saved yet
    job.stop();
    expect(cachedIds().sort()).toEqual(["0", "1", "2"]);
    job.stop(); // idempotent: it is also called from an exit handler
    expect(cachedIds().sort()).toEqual(["0", "1", "2"]);
  });

  it("saves once at the end and has nothing left to read on the next run", async () => {
    const { roots, cachePath, cachedIds } = setup(3);
    const job = new IndexJob({ roots, cachePath });
    await vi.runAllTimersAsync();
    expect(cachedIds().sort()).toEqual(["0", "1", "2"]);
    const warm = new IndexJob({ roots, cachePath });
    expect(warm.progress()).toBeUndefined();
    expect(warm.sessions.some((s) => s.pending)).toBe(false);
    expect(titles(warm)).toEqual(titles(job));
  });

  it("shows a changed file as a placeholder again and re-reads only it", async () => {
    const { roots, cachePath, files } = setup(3);
    new IndexJob({ roots, cachePath });
    await vi.runAllTimersAsync();
    writeFileSync(files[1]!, `${readFileSync(files[1]!, "utf8")}${JSON.stringify({ type: "ai-title", aiTitle: "New title" })}\n`);
    const job = new IndexJob({ roots, cachePath, sliceMs: 0 });
    expect(job.sessions.filter((s) => s.pending).map((s) => s.id)).toEqual(["sess-1"]); // (its new mtime also makes it the newest)
    expect(job.progress()).toEqual({ done: 2, total: 3 });
    await vi.runAllTimersAsync();
    expect(job.sessions.find((s) => s.id === "sess-1")!.title).toBe("New title");
  });

  it("drops a file that vanished before it was read", async () => {
    const { roots, cachePath, files, cachedIds } = setup(3);
    const job = new IndexJob({ roots, cachePath, sliceMs: 0 });
    rmSync(files[1]!);
    await vi.runAllTimersAsync();
    expect(job.sessions.map((s) => s.id)).toEqual(["sess-0", "sess-2"]);
    expect(cachedIds().sort()).toEqual(["0", "2"]);
  });

  describe("refresh (ass-gnso)", () => {
    const addTitle = (file: string, title: string) => writeFileSync(file, `${readFileSync(file, "utf8")}${JSON.stringify({ type: "ai-title", aiTitle: title })}\n`);
    /** A job that has read everything, over `n` sessions. */
    async function ready(n: number) {
      const env = setup(n);
      const job = new IndexJob({ roots: env.roots, cachePath: env.cachePath, sliceMs: 0 });
      await vi.runAllTimersAsync();
      return { ...env, job };
    }

    it("picks up a session that appeared as a placeholder, newest first, and reads it", async () => {
      const { dir, job } = await ready(2);
      const file = join(dir, "claude", "-home-x", "sess-new.jsonl");
      writeFileSync(file, new ClaudeTranscript("sess-new", "/home/tester/work/demo").user("a brand new prompt").toJsonl());
      utimesSync(file, new Date(2026, 0, 2), new Date(2026, 0, 2));
      const rows = job.sessions;
      let heard = 0;
      job.subscribe(() => heard++);
      job.refresh();
      expect(job.sessions).toBe(rows); // the same array, changed in place: the source holds it
      expect(job.sessions.map((s) => s.id)).toEqual(["sess-new", "sess-0", "sess-1"]);
      expect(job.sessions[0]!.pending).toBe(true);
      expect(job.progress()).toEqual({ done: 2, total: 3 });
      expect(heard).toBe(1); // listeners hear about the new row at once
      await vi.runAllTimersAsync();
      expect(job.sessions[0]).toMatchObject({ id: "sess-new", firstPrompt: "a brand new prompt" });
      expect(job.sessions.some((s) => s.pending)).toBe(false);
      expect(job.progress()).toBeUndefined();
    });

    it("re-reads a session that grew, keeping its old row on screen until then, and leaves the others alone", async () => {
      const { files, job } = await ready(3);
      const before = [...job.sessions];
      addTitle(files[1]!, "A newer title");
      job.refresh();
      const grown = job.sessions.find((s) => s.id === "sess-1")!;
      expect(grown).toBe(before.find((s) => s.id === "sess-1")); // not a placeholder: the row does not flicker
      expect(grown.title).toBe("Title 1");
      expect(job.progress()).toEqual({ done: 2, total: 3 });
      await vi.runAllTimersAsync();
      expect(job.sessions.find((s) => s.id === "sess-1")!.title).toBe("A newer title");
      // The rows that did not change are the very objects they were: nothing else was read.
      for (const id of ["sess-0", "sess-2"]) expect(job.sessions.find((s) => s.id === id)).toBe(before.find((s) => s.id === id));
    });

    it("drops a session whose file is gone, and the cache forgets it", async () => {
      const { files, job, cachedIds } = await ready(3);
      rmSync(files[1]!);
      job.refresh();
      expect(job.sessions.map((s) => s.id)).toEqual(["sess-0", "sess-2"]);
      expect(job.progress()).toBeUndefined(); // nothing to read
      expect(cachedIds().sort()).toEqual(["0", "2"]);
    });

    it("a changed file that cannot be read any more leaves the list and the cache, and its old text is not saved again", async () => {
      const { files, job, cachePath, cachedIds } = await ready(3);
      addTitle(files[1]!, "Edited, then deleted before it was read");
      job.refresh(); // sess-1 is queued; its old row stays on screen
      rmSync(files[1]!);
      await vi.runAllTimersAsync();
      expect(job.sessions.map((s) => s.id)).toEqual(["sess-0", "sess-2"]);
      job.stop();
      expect(cachedIds().sort()).toEqual(["0", "2"]);
      expect(readFileSync(cachePath, "utf8")).not.toContain("prompt 1");
    });

    it("with nothing changed it reads nothing and starts no work", async () => {
      const { job } = await ready(3);
      const before = [...job.sessions];
      let heard = 0;
      job.subscribe(() => heard++);
      job.refresh();
      expect(job.sessions).toEqual(before);
      expect(job.progress()).toBeUndefined();
      expect(vi.getTimerCount()).toBe(0);
      expect(heard).toBe(1);
    });

    it("during a running index it keeps what was read and queues the rest once", async () => {
      const { files, roots, cachePath } = setup(4);
      const job = new IndexJob({ roots, cachePath, sliceMs: 0 });
      await slices(1); // sess-0 is read
      addTitle(files[0]!, "Edited while reading");
      job.refresh();
      expect(job.progress()).toEqual({ done: 0, total: 4 }); // sess-0 changed, so everything is still to be read
      await vi.runAllTimersAsync();
      expect(job.sessions.some((s) => s.pending)).toBe(false);
      expect(job.sessions.map((s) => s.title)).toEqual(["Edited while reading", "Title 1", "Title 2", "Title 3"]);
    });
  });
});

describe("summarizeRaw keeps the last thing the assistant said", () => {
  it("claude-code: the last message with text, not a later one that only calls tools", () => {
    const t = new ClaudeTranscript("sess-reply", "/home/tester/work/demo");
    t.user("do it");
    t.assistant("m1", [{ type: "text", text: "First  answer" }], ccUsage(1, 1));
    t.user("and more");
    t.assistant("m2", [{ type: "text", text: "Done.\n\nAll\n  fixed." }, { type: "tool_use", id: "t1", name: "Bash", input: {} }], ccUsage(1, 1));
    t.toolResult("t1", "ok");
    t.assistant("m3", [{ type: "tool_use", id: "t2", name: "Bash", input: {} }], ccUsage(1, 1));
    expect(summarizeRaw(ref("claude-code"), t.toJsonl()).lastReply).toBe("Done. All fixed.");
  });

  it("pi: the last assistant text", () => {
    const t = new PiTranscript("pi-reply", "/home/tester/work/demo");
    t.user("go");
    t.assistant([{ type: "text", text: "early" }]);
    t.assistant([{ type: "text", text: "the end" }, { type: "toolCall", id: "c1", name: "read", arguments: {} }]);
    t.assistant([{ type: "toolCall", id: "c2", name: "read", arguments: {} }]);
    expect(summarizeRaw(ref("pi"), t.toJsonl()).lastReply).toBe("the end");
  });

  it("is undefined when the assistant never wrote any text", () => {
    const t = new ClaudeTranscript("sess-silent", "/home/tester/work/demo");
    t.user("go");
    t.assistant("m1", [{ type: "tool_use", id: "t1", name: "Bash", input: {} }], ccUsage(1, 1));
    expect(summarizeRaw(ref("claude-code"), t.toJsonl()).lastReply).toBeUndefined();
  });

  it("is cut at about 600 characters and stripped of control sequences", () => {
    const evil = "\x1b]52;c;ZXZpbA==\x07\x1b[2J";
    const t = new ClaudeTranscript("sess-long", "/home/tester/work/demo");
    t.user("go");
    t.assistant("m1", [{ type: "text", text: `${evil}${"word ".repeat(300)}` }], ccUsage(1, 1));
    const reply = summarizeRaw(ref("claude-code"), t.toJsonl()).lastReply!;
    expect(reply.length).toBeLessThanOrEqual(600); // cut first, then stripped (like prompts), so the stripped bytes come off the 600
    expect(reply.length).toBeGreaterThan(500);
    expect(reply.endsWith("…")).toBe(true);
    expect(reply).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
  });
});
