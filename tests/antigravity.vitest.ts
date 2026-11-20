import { mkdirSync, mkdtempSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.js";
import { antigravity } from "../src/harnesses/antigravity/index.js";
import { dataFolders, resetAntigravityCaches } from "../src/harnesses/antigravity/files.js";
import { MISSING_OUTPUT, SHORTENED_FIELD, SKIPPED_RESULT, parseAntigravity, unwrapPrompt } from "../src/harnesses/antigravity/parse.js";
import { detectHarness, readSession } from "../src/harnesses/index.js";
import { Collector } from "../src/harnesses/summary-kit.js";
import { prepareShare } from "../src/pipeline.js";
import { resolveSession } from "../src/resolve.js";
import { SHARE_MODES, type ToolStep } from "../src/schema.js";
import { AntigravityConversation, wrapPrompt } from "./antigravity-helpers.js";
import { fake } from "./helpers.js";

afterEach(() => resetAntigravityCaches());

const tools = (steps: { kind: string }[]) => steps.filter((s): s is ToolStep => s.kind === "tool");

function dataDir(): string {
  return mkdtempSync(join(tmpdir(), "ag-data-"));
}

/** A data folder holding `c`, read the way the CLI reads it. */
function load(c: AntigravityConversation, opts: Parameters<AntigravityConversation["write"]>[1] = {}) {
  const data = dataDir();
  const file = c.write(data, opts);
  return { data, file, ...readSession("antigravity", file) };
}

const share = (l: ReturnType<typeof load>, mode: (typeof SHARE_MODES)[number] = "full") => prepareShare(l.raw, { mode, config: DEFAULT_CONFIG, harness: "antigravity", knownSecrets: [], ...l.options });

/** Two prompts (the first under T3), parallel calls, an MCP tool, a background task killed with manage_task, a stream error. */
function conversation(): AntigravityConversation {
  return new AntigravityConversation()
    .user("Why does the build fail?", { t3: true, settings: ["The user changed setting `Model Selection` from None to Gemini 4 Neon (High). No need to comment on this change."] })
    .respond({
      thinking: "Check the build log and the config.",
      text: "Looking at both.",
      calls: [
        { name: "run_command", args: { CommandLine: "npm run build", WaitMsBeforeAsync: 5000, toolSummary: "Build" }, result: "error TS2322 in src/a.ts" },
        { name: "read_file", args: { Path: "/home/tester/work/demo/tsconfig.json" }, result: '{"strict": true}' },
      ],
      input: 6_000,
      cacheRead: 30_000,
      output: 200,
    })
    .respond({ calls: [{ name: "run_command", args: { CommandLine: "npm test", WaitMsBeforeAsync: 500 }, status: "RUNNING", result: "Tool is running as a background task with task id: x/task-7\nTask Description: npm test" }], input: "700", cacheRead: 36_000, output: 40 })
    .system('[Message] timestamp=2026-01-01T10:01:00Z sender=x/task-7 priority=MESSAGE_PRIORITY_HIGH content=Task id "x/task-7" finished: 3 tests failed')
    .respond({ calls: [{ name: "manage_task", args: { Action: "kill", TaskId: "x/task-8" }, result: "killed" }, { name: "mcp_t3-code_pull_request_create", args: { title: "Fix build", body: "…", toolSummary: "Open a PR" }, result: "PR #1 opened" }], input: 300, cacheRead: 36_500, output: 30 })
    .respond({ text: "Fixed the type error and opened a PR.", input: 200, cacheRead: 37_000, output: 60 })
    .system("Reminder: work efficiently. REMINDER-MARKER")
    .user("thanks", { settings: ["The user changed setting `Model Selection` from Gemini 4 Neon (High) to Gemini 4 Neon (Medium). No need to comment on this change."] })
    .error("The stream was interrupted. Please continue the task you were working on.");
}

describe("antigravity: detect", () => {
  it("recognises a transcript line by all its keys and known values, and nothing generic", () => {
    expect(detectHarness(conversation().toJsonl())).toBe("antigravity");
    expect(antigravity.detect({ step_index: 0, type: "USER_INPUT", source: "USER_EXPLICIT", status: "DONE" })).toBe(false); // no created_at
    expect(antigravity.detect({ step_index: 0, type: "SOMETHING", source: "MODEL", status: "DONE", created_at: "x" })).toBe(false);
    expect(antigravity.detect({ step_index: "0", type: "GENERIC", source: "MODEL", status: "DONE", created_at: "x" })).toBe(false);
    expect(antigravity.detect({ step_index: 3, type: "RUN_COMMAND", source: "MODEL", status: "DONE", created_at: "x" })).toBe(true);
  });
});

describe("antigravity: prompts", () => {
  it("takes what the user typed: the nested request under T3, else the request, never the wrapper", () => {
    expect(unwrapPrompt(wrapPrompt("plain ask")).text).toBe("plain ask");
    expect(unwrapPrompt(wrapPrompt("inside T3", { t3: true })).text).toBe("inside T3");
    expect(unwrapPrompt("no wrapper at all").text).toBe("no wrapper at all");
    // A plain prompt that mentions the tag is not mistaken for T3's wrapper.
    const literal = "Explain why <user_request>x</user_request> breaks the parser, then fix it";
    expect(unwrapPrompt(wrapPrompt(literal)).text).toBe(literal);
  });

  it("marks prompts authored, so prompts mode shows only the typed text", () => {
    const l = load(conversation());
    const p = share(l, "prompts");
    expect(p.session.turns.map((t) => t.user?.text)).toEqual(["Why does the build fail?", "thanks"]);
    expect(p.session.turns.every((t) => t.user?.authored)).toBe(true);
    for (const marker of ["T3-INSTRUCTIONS-MARKER", "RUNTIME-MARKER", "ADDITIONAL-METADATA-MARKER", "REMINDER-MARKER"]) expect(p.json).not.toContain(marker);
    expect(share(l).json).not.toContain("T3-INSTRUCTIONS-MARKER");
  });

  it("turns a model change into an event, and the first selection into none", () => {
    const { session } = parseAntigravity(conversation().toJsonl());
    const events = session.turns.flatMap((t) => t.steps).filter((s) => s.kind === "event").map((s) => s.kind === "event" && [s.event, s.text]);
    expect(events).toContainEqual(["model_change", "Model → Gemini 4 Neon (Medium)"]);
    expect(events.filter((e) => e && e[0] === "model_change")).toHaveLength(1);
  });
});

describe("antigravity: parse with the conversation database", () => {
  it("attaches each result to the call the database says it answers, parallel calls included", () => {
    const l = load(conversation());
    const steps = parseAntigravity(l.raw, l.options).session.turns[0]!.steps;
    const t = tools(steps);
    expect(t.map((s) => [s.name, s.action, s.summary, s.result?.text])).toEqual([
      ["run_command", "exec", "npm run build", "error TS2322 in src/a.ts"],
      ["read_file", "read", "/home/tester/work/demo/tsconfig.json", '{"strict": true}'],
      ["run_command", "exec", "npm test", "Tool is running as a background task with task id: x/task-7\nTask Description: npm test"],
      ["manage_task", "other", "kill x/task-8", "killed"],
      ["mcp_t3-code_pull_request_create", "other", "Open a PR", "PR #1 opened"],
    ]);
    expect(t.every((s) => s.id.startsWith("call_"))).toBe(true);
    expect(steps.find((s) => s.kind === "event" && s.event === "notification")).toMatchObject({ text: 'Task id "x/task-7" finished: 3 tests failed' });
  });

  it("shows a call whose step the transcript skipped as not run, from the database's status", () => {
    const c = new AntigravityConversation().user("go").respond({ calls: [{ name: "run_command", args: { CommandLine: "a" }, result: "A" }, { name: "run_command", args: { CommandLine: "b" }, skipped: true }] });
    const l = load(c);
    const { session, dropped } = parseAntigravity(l.raw, l.options);
    expect(tools(session.turns[0]!.steps).map((s) => s.result?.text)).toEqual(["A", SKIPPED_RESULT]);
    expect(dropped["skipped-step"]).toBe(1);
  });

  it("pairs by id across a step the transcript skipped (a result in the database only)", () => {
    const c = new AntigravityConversation()
      .user("go")
      .respond({ calls: [{ name: "run_command", args: { CommandLine: "a" }, result: "A" }, { name: "run_command", args: { CommandLine: "b" }, skipped: true }, { name: "run_command", args: { CommandLine: "c" }, result: "C" }] })
      .system("Reminder: work efficiently.");
    const l = load(c);
    const t = tools(parseAntigravity(l.raw, l.options).session.turns[0]!.steps);
    expect(t.map((s) => [s.summary, s.result?.text])).toEqual([["a", "A"], ["b", SKIPPED_RESULT], ["c", "C"]]);
  });

  it("without a database, pairs by position only while the steps line up, else leaves results unpaired", () => {
    const lined = new AntigravityConversation().user("go").respond({ calls: [{ name: "run_command", args: { CommandLine: "a" }, result: "A" }, { name: "run_command", args: { CommandLine: "b" }, result: "B" }] });
    expect(tools(parseAntigravity(lined.toJsonl()).session.turns[0]!.steps).map((s) => s.result?.text)).toEqual(["A", "B"]);
    const gap = new AntigravityConversation().user("go").respond({ calls: [{ name: "run_command", args: { CommandLine: "a" }, result: "A" }, { name: "run_command", args: { CommandLine: "b" }, skipped: true }, { name: "run_command", args: { CommandLine: "c" }, result: "C" }] });
    const t = tools(parseAntigravity(gap.toJsonl()).session.turns[0]!.steps);
    // "C" follows a gap: it is not given to the call for "b".
    expect(t.map((s) => [s.summary, s.result?.text])).toEqual([["a", "A"], ["b", undefined], ["c", undefined], ["result of a call this transcript does not identify", "C"]]);
  });

  it("takes the working directory, branch and title from the database and the annotation", () => {
    const c = new AntigravityConversation("0a9e0000-1111-4222-8333-444455550001", [{ path: "/home/tester/.local/share/t3/userdata/attachments" }, { path: "/home/tester/work/demo", repo: "tester/demo", branch: "fix/build" }]).user("go").respond({ text: "ok" });
    const l = load(c, { title: "Fix the build" });
    const { session } = parseAntigravity(l.raw, l.options);
    expect(session.source.sessionId).toBe("0a9e0000-1111-4222-8333-444455550001");
    expect(session.title).toBe("Fix the build");
    expect(session.project).toMatchObject({ cwd: "/home/tester/work/demo", name: "demo", branch: "fix/build" });
  });

  it("reads a conversation without a database, with no project", () => {
    const l = load(conversation(), { db: false });
    const { session } = parseAntigravity(l.raw, l.options);
    expect(session.project).toBeUndefined();
    expect(session.turns).toHaveLength(2);
  });

  it("counts usage per response (input without cache reads, numeric strings too) and estimates the cost by the base model", () => {
    const l = load(conversation());
    const p = share(l);
    expect(p.session.responses.map((r) => [r.usage.input, r.usage.cacheRead, r.usage.output])).toEqual([[6_000, 30_000, 200], [700, 36_000, 40], [300, 36_500, 30], [200, 37_000, 60]]);
    // gemini-4-neon: $3 input, $0.15 cached, $15 output per million.
    expect(p.session.responses[0]!.usage.cost).toBeCloseTo((6_000 * 3 + 30_000 * 0.15 + 200 * 15) / 1e6, 12);
    expect(p.session.stats).toMatchObject({ costSource: "estimated", tokens: { input: 7_200, cacheRead: 139_500, output: 330 } });
    expect(p.session.models).toEqual(["gemini-4-neon-high"]);
  });

  it("splits output into thinking and reply, and adds cache writes, from the database when it agrees with the transcript", () => {
    const c = new AntigravityConversation()
      .user("go")
      .respond({ thinking: "plan", text: "a", input: 2_000, cacheRead: 10_000, output: 300, db: { thinking: 120 } })
      .respond({ text: "b", input: 500, cacheRead: 12_000, output: 80, model: "claude-sonnet-5-5", db: { thinking: 30, cacheWrite: 4_000 } })
      // The database disagrees (input): the transcript stands, and the report says so.
      .respond({ text: "c", input: 700, output: 40, db: { thinking: 10, input: 999 } });
    const l = load(c);
    const p = share(l);
    expect(p.session.responses.map((r) => [r.usage.reasoning, r.usage.cacheWrite])).toEqual([[120, 0], [30, 4_000], [0, 0]]);
    expect(p.session.stats.thinking.tokens).toBe(150);
    expect(p.report.dropped["db-usage-mismatch"]).toBe(1);
    // A Claude model's cache writes are priced as writes ($2.50 for Sonnet 5.5).
    expect(p.session.responses[1]!.usage.cost).toBeCloseTo((500 * 2 + 12_000 * 0.1 + 4_000 * 2.5 + 80 * 10) / 1e6, 12);
  });

  it("uses the database's call ids only when its calls are the transcript's, else pairs by position and says so", () => {
    const c = new AntigravityConversation().user("go").respond({ calls: [{ name: "run_command", args: { CommandLine: "a" }, result: "A" }, { name: "read_file", args: { Path: "/x" }, result: "X" }] });
    // The database lists other tools for this response (a different version's layout, say).
    const row = c.dbSteps.find((r) => r.type === 15)!;
    const listed = row.payload.find(([f]) => f === 20)![1] as [number, [number, unknown][]][];
    for (const [, call] of listed) call.find(([f]) => f === 2)![1] = "something_else";
    const l = load(c);
    const { session, dropped } = parseAntigravity(l.raw, l.options);
    expect(tools(session.turns[0]!.steps).map((s) => [s.name, s.result?.text])).toEqual([["run_command", "A"], ["read_file", "X"]]);
    expect(dropped["db-call-mismatch"]).toBe(1);
  });

  it("gives a verified call's late result to that call, never by position to a later unverified one", () => {
    // A: a background command whose result comes after B's response. B: the database lists other tools (unverified).
    const c = new AntigravityConversation().user("go");
    c.respond({ calls: [{ name: "run_command", args: { CommandLine: "a" }, result: "A" }] }).respond({ calls: [{ name: "read_file", args: { Path: "/x" }, result: "X" }] });
    const [user, planA, resultA, planB, resultB] = c.steps;
    c.steps = [user!, { ...planA!, step_index: 1 }, { ...planB!, step_index: 2 }, { ...resultA!, step_index: 3 }, { ...resultB!, step_index: 4 }];
    const rows = c.dbSteps;
    const byOld = (i: number) => rows.find((r) => r.idx === i)!;
    c.dbSteps = [byOld(0), { ...byOld(1), idx: 1 }, { ...byOld(3), idx: 2 }, { ...byOld(2), idx: 3 }, { ...byOld(4), idx: 4 }];
    const listed = c.dbSteps[2]!.payload.find(([f]) => f === 20)![1] as [number, [number, unknown][]][];
    for (const [, call] of listed) call.find(([f]) => f === 2)![1] = "something_else";
    const l = load(c);
    const t = tools(parseAntigravity(l.raw, l.options).session.turns[0]!.steps);
    expect(t.find((s) => s.name === "run_command")?.result?.text).toBe("A");
    expect(t.find((s) => s.name === "read_file")?.result?.text).not.toBe("A");
  });

  it("does not accept the database's ids for two calls of one tool listed in another order", () => {
    const c = new AntigravityConversation().user("go").respond({ calls: [{ name: "run_command", args: { CommandLine: "first" }, result: "1" }, { name: "run_command", args: { CommandLine: "second" }, result: "2" }] });
    // The database lists the same two calls swapped (names agree, arguments do not).
    const row = c.dbSteps.find((r) => r.type === 15)!;
    const listed = row.payload.find(([f]) => f === 20)![1] as [number, [number, unknown][]][];
    const [x, y] = [listed[0]![1].find(([f]) => f === 3)!, listed[1]![1].find(([f]) => f === 3)!];
    [x[1], y[1]] = [y[1], x[1]];
    const l = load(c);
    const { session, dropped } = parseAntigravity(l.raw, l.options);
    expect(dropped["db-call-mismatch"]).toBe(1);
    expect(tools(session.turns[0]!.steps).map((s) => [s.summary, s.result?.text])).toEqual([["first", "1"], ["second", "2"]]);
  });

  it("keeps the transcript's cache writes when it records them, and counts a disagreement", () => {
    const c = new AntigravityConversation().user("go").respond({ text: "a", input: 500, cacheRead: 1_000, output: 20, db: { cacheWrite: 9_000 } });
    (c.steps[1] as Record<string, unknown>).cache_write_tokens = 300;
    const l = load(c);
    const { session, dropped } = parseAntigravity(l.raw, l.options);
    expect(session.responses[0]!.usage.cacheWrite).toBe(300);
    expect(dropped["db-usage-mismatch"]).toBe(1);
  });

  it("takes the base model from the database when the transcript names none", () => {
    const c = new AntigravityConversation().user("go").respond({ text: "a", omitModel: true, db: { baseModel: "gemini-4-argon" } });
    const l = load(c);
    expect(parseAntigravity(l.raw, l.options).session.responses[0]!.model).toBe("gemini-4-argon");
    // The browser's index reads it the same way, so a `model:` search finds the session.
    const collector = new Collector();
    antigravity.summarize(l.raw, collector, antigravity.sidecar!.load(l.file, "summary"));
    expect(collector.models).toEqual(["gemini-4-argon"]);
  });

  it("falls back to the transcript alone when the database has an unknown layout", () => {
    const data = dataDir();
    const c = new AntigravityConversation().user("go").respond({ text: "a", calls: [{ name: "run_command", args: { CommandLine: "x" }, result: "X" }] });
    const file = c.write(data, { db: false });
    mkdirSync(join(data, "conversations"), { recursive: true });
    writeFileSync(join(data, "conversations", `${c.id}.db`), "not a database");
    const { raw, options } = readSession("antigravity", file);
    const t = tools(parseAntigravity(raw, options).session.turns[0]!.steps);
    expect(t.map((s) => s.result?.text)).toEqual(["X"]);
  });

  it("records a stream error and counts images", () => {
    const c = new AntigravityConversation().user("look", { media: 1 }).respond({ calls: [{ name: "read_file", args: { Path: "/x/shot.png" }, result: "image", media: 2 }] }).error("The stream was interrupted. Please continue.");
    const l = load(c);
    const { session } = parseAntigravity(l.raw, l.options);
    expect(session.turns[0]!.user?.images).toBe(1);
    expect(tools(session.turns[0]!.steps)[0]!.result?.images).toBe(2);
    expect(session.turns[0]!.steps.at(-1)).toMatchObject({ kind: "event", event: "error", text: "The stream was interrupted. Please continue." });
  });
});

describe("antigravity: shortened tool output", () => {
  it("redacts a secret across the cut from the full output, never sharing the cut preview", () => {
    const secret = fake.github();
    const full = `${"line of output\n".repeat(40)}TOKEN=${secret}\n${"more output\n".repeat(40)}`;
    const at = full.indexOf(secret) + 10;
    const c = new AntigravityConversation().user("dump");
    const preview = c.shortened(full, [at, at + 200]);
    c.respond({ calls: [{ name: "run_command", args: { CommandLine: "cat build.log" }, result: preview }] });
    const l = load(c);
    for (const mode of SHARE_MODES) {
      const p = share(l, mode);
      expect(p.json, mode).not.toContain(secret.slice(0, 10));
    }
    const p = share(l);
    const result = tools(p.session.turns[0]!.steps)[0]!.result!.text;
    expect(result).toContain("more output");
    expect(result).not.toContain("<truncated 12 lines>");
    expect(p.report.counts["secret-pattern"] ?? 0).toBeGreaterThan(0);
  });

  it("reads no output for a transcript outside its conversation layout, nor one linked out of the conversation", () => {
    const secret = fake.github();
    const full = `x\nTOKEN=${secret}\ny\n`;
    const c = new AntigravityConversation().user("dump");
    const preview = c.shortened(full, [full.indexOf(secret) + 12, full.length - 2]);
    c.respond({ calls: [{ name: "run_command", args: { CommandLine: "cat" }, result: preview }] });
    // A loose copy, with an unrelated steps/<n>/output.txt beside it.
    const loose = mkdtempSync(join(tmpdir(), "ag-loose-"));
    mkdirSync(join(loose, "x", "steps", "2"), { recursive: true });
    writeFileSync(join(loose, "x", "steps", "2", "output.txt"), "UNRELATED-LOCAL-FILE");
    mkdirSync(join(loose, "x", "logs"), { recursive: true });
    const looseFile = join(loose, "x", "logs", "transcript_full.jsonl");
    writeFileSync(looseFile, c.toJsonl());
    const a = readSession("antigravity", looseFile);
    expect(prepareShare(a.raw, { mode: "full", config: DEFAULT_CONFIG, harness: "antigravity", knownSecrets: [], ...a.options }).json).not.toContain("UNRELATED-LOCAL-FILE");
    // In its layout, but the output file is a link to a file outside the conversation.
    const l = load(c, { outputs: false });
    const outside = join(mkdtempSync(join(tmpdir(), "ag-outside-")), "secret.txt");
    writeFileSync(outside, "OUTSIDE-THE-CONVERSATION");
    const stepDir = join(l.data, "brain", c.id, ".system_generated", "steps", "2");
    mkdirSync(stepDir, { recursive: true });
    symlinkSync(outside, join(stepDir, "output.txt"));
    const b = readSession("antigravity", l.file);
    const p = prepareShare(b.raw, { mode: "full", config: DEFAULT_CONFIG, harness: "antigravity", knownSecrets: [], ...b.options });
    expect(p.json).not.toContain("OUTSIDE-THE-CONVERSATION");
    expect(tools(p.session.turns[0]!.steps)[0]!.result?.text).toBe(MISSING_OUTPUT);
  });

  it("holds full outputs to the size budget before reading them, and reads none for the browser's index", () => {
    const c = new AntigravityConversation().user("dump");
    const full = "y".repeat(1_200_000);
    const preview = c.shortened(full, [100, full.length - 100]);
    c.respond({ calls: [{ name: "run_command", args: { CommandLine: "cat" }, result: preview }] });
    const l = load(c);
    expect((l.options.sidecar as { outputs: Record<string, string | null> }).outputs[2]).toBe(full);
    expect(antigravity.sidecar!.load(l.file, "summary")).not.toHaveProperty("outputs");
    const prev = process.env.OVERSHARE_MAX_SESSION_MB;
    process.env.OVERSHARE_MAX_SESSION_MB = "1";
    try {
      expect((antigravity.sidecar!.load(l.file) as { outputs: Record<string, string | null> }).outputs[2]).toBeNull();
    } finally {
      if (prev === undefined) delete process.env.OVERSHARE_MAX_SESSION_MB;
      else process.env.OVERSHARE_MAX_SESSION_MB = prev;
    }
  });

  it("never shares a field the shortened transcript.jsonl cut (the fallback when the full one is missing)", () => {
    const secret = fake.github();
    const data = dataDir();
    const c = new AntigravityConversation().user("go").respond({ text: "ok", calls: [{ name: "run_command", args: { CommandLine: "env" }, result: "x" }] });
    const lines = c.toJsonl().trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    // The result's content and the call's arguments were cut mid-secret.
    lines[2]!.content = `TOKEN=${secret.slice(0, 14)}\n<truncated 40 lines>\nend`;
    lines[2]!.truncated_fields = ["content"];
    (lines[1]!.tool_calls as Record<string, unknown>[])[0]!.args = { CommandLine: `echo ${secret.slice(0, 16)}<truncated>` };
    lines[1]!.truncated_fields = ["tool_calls"];
    const logs = join(data, "brain", c.id, ".system_generated", "logs");
    mkdirSync(logs, { recursive: true });
    const file = join(logs, "transcript.jsonl");
    writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
    expect(antigravity.listFiles(data)).toEqual([file]);
    const r = readSession("antigravity", file);
    const p = prepareShare(r.raw, { mode: "full", config: DEFAULT_CONFIG, harness: "antigravity", knownSecrets: [], ...r.options });
    expect(p.json).not.toContain(secret.slice(0, 10));
    expect(tools(p.session.turns[0]!.steps)[0]).toMatchObject({ name: "run_command", result: { text: SHORTENED_FIELD } });
    expect(p.report.dropped["shortened-field"]).toBe(2);
  });

  it("drops the preview when the full output file is gone", () => {
    const secret = fake.github();
    const full = `x\nTOKEN=${secret}\ny\n`;
    const c = new AntigravityConversation().user("dump");
    const preview = c.shortened(full, [full.indexOf(secret) + 12, full.length - 2]);
    c.respond({ calls: [{ name: "run_command", args: { CommandLine: "cat" }, result: preview }] });
    const l = load(c, { outputs: false });
    const p = share(l);
    expect(tools(p.session.turns[0]!.steps)[0]!.result?.text).toBe(MISSING_OUTPUT);
    expect(p.json).not.toContain(secret.slice(0, 12));
    expect(p.session.redaction?.dropped["shortened-output"]).toBe(1);
  });
});

describe("antigravity: files", () => {
  it("finds data folders at their known places under home, or takes one data folder as the root", () => {
    const home = dataDir();
    const t3 = join(home, ".local/share/t3/userdata/providers/antigravity/abc123/antigravity-acp");
    const app = join(home, ".gemini/antigravity");
    for (const d of [t3, app]) mkdirSync(join(d, "brain"), { recursive: true });
    mkdirSync(join(home, ".gemini/antigravity-ide"), { recursive: true }); // no brain/: not a data folder
    expect(dataFolders(home).sort()).toEqual([app, t3].sort());
    expect(dataFolders(app)).toEqual([app]);
    expect(antigravity.sessionsRoot({ ANTIGRAVITY_DATA_DIR: app }, home)).toBe(app);
    expect(antigravity.sessionsRoot({ OVERSHARE_ANTIGRAVITY_DIR: t3, ANTIGRAVITY_DATA_DIR: app }, home)).toBe(t3);
    expect(antigravity.credentialFiles?.({}, home).sort()).toEqual([join(app, "antigravity-oauth-token"), join(t3, "antigravity-oauth-token")].sort());
  });

  it("lists conversations with a transcript, filters by any workspace, and skips empty ones", () => {
    const data = dataDir();
    const a = new AntigravityConversation("0a9e0000-1111-4222-8333-44445555000a", [{ path: "/home/tester/.local/share/t3/userdata/attachments" }, { path: "/work/one", repo: "t/one", branch: "main" }]).user("a").respond({ text: "a" });
    const b = new AntigravityConversation("0a9e0000-1111-4222-8333-44445555000b", [{ path: "/work/two" }]).user("b").respond({ text: "b" });
    const fa = a.write(data);
    const fb = b.write(data);
    mkdirSync(join(data, "brain", "0a9e0000-1111-4222-8333-44445555000c"), { recursive: true }); // set up, never used
    expect(antigravity.listFiles(data).sort()).toEqual([fa, fb].sort());
    expect(antigravity.listFiles(data, "/work/one")).toEqual([fa]);
    expect(antigravity.listFiles(data, "/home/tester/.local/share/t3/userdata/attachments")).toEqual([fa]);
    expect(antigravity.sessionId(fa)).toBe("0a9e0000-1111-4222-8333-44445555000a");
    expect(antigravity.sessionCwd?.(fa)).toBe("/work/one");
    const roots = { "claude-code": join(data, "none"), pi: join(data, "none"), codex: join(data, "none"), antigravity: data };
    expect(resolveSession(undefined, { current: true, env: { ANTIGRAVITY_CONVERSATION_ID: b.id }, cwd: "/work/one", roots }).path).toBe(fb);
    utimesSync(fb, new Date(2025, 0, 1), new Date(2025, 0, 1));
    expect(resolveSession(undefined, { current: true, env: {}, cwd: "/work/one", roots }).path).toBe(fa);
  });

  it("never picks a conversation without a database for a directory, but lists and reads it", () => {
    const data = dataDir();
    const c = new AntigravityConversation("0a9e0000-1111-4222-8333-44445555000d").user("x").respond({ text: "y" });
    const f = c.write(data, { db: false });
    expect(antigravity.listFiles(data)).toEqual([f]);
    expect(antigravity.listFiles(data, "/home/tester/work/demo")).toEqual([]);
    expect(readSession("antigravity", f).raw).toContain("USER_INPUT");
  });

  it("summarizes for the browser, with the title and project from the sidecar", () => {
    const l = load(conversation(), { title: "Build failure" });
    const c = new Collector();
    antigravity.summarize(l.raw, c, l.options.sidecar);
    expect(c.title).toBe("Build failure");
    expect(c.cwd).toBe("/home/tester/work/demo");
    expect(c.branch).toBe("main");
    expect(c.promptHead).toEqual(["Why does the build fail?", "thanks"]);
    expect(c.calls).toBe(4);
    expect(c.models).toEqual(["gemini-4-neon-high"]);
    expect(c.tools).toMatchObject({ run_command: 2, read_file: 1, manage_task: 1 });
  });

  it("reads the annotation title with escapes, and refreshes the browse key when the database changes", () => {
    const data = dataDir();
    const c = new AntigravityConversation("0a9e0000-1111-4222-8333-44445555000e").user("x");
    const f = c.write(data, { title: 'Say "hi"' });
    expect(readSession("antigravity", f).options.sidecar).toMatchObject({ title: 'Say "hi"' });
    const key = antigravity.sidecar!.key(f);
    writeFileSync(join(data, "annotations", `${c.id}.pbtxt`), 'title:"Renamed"\n');
    utimesSync(join(data, "annotations", `${c.id}.pbtxt`), new Date(2027, 0, 1), new Date(2027, 0, 1));
    expect(antigravity.sidecar!.key(f)).not.toBe(key);
  });
});
