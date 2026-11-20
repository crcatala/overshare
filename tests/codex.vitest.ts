import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { zstdCompressSync } from "node:zlib";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.js";
import { codex } from "../src/harnesses/codex/index.js";
import { resetCodexCaches } from "../src/harnesses/codex/files.js";
import { LEGACY_MESSAGE, parseCodex } from "../src/harnesses/codex/parse.js";
import { SessionTooLargeError, UnsupportedFormatError, detectHarness, readSession } from "../src/harnesses/index.js";
import { toSafeError } from "../src/browse/job.js";
import { Collector } from "../src/harnesses/summary-kit.js";
import { prepareShare } from "../src/pipeline.js";
import { resolveSession, sniffHarness } from "../src/resolve.js";
import { SHARE_MODES, type SubagentStep, type ToolStep } from "../src/schema.js";
import { buildIndex } from "../src/sessions/index.js";
import { summarizeFile } from "../src/sessions/summary.js";
import { AGENTS_MD, BASE_INSTRUCTIONS, CodexTranscript, DEVELOPER_TEXT, WORLD_STATE_MARKER, encryptedBlob } from "./codex-helpers.js";

const parse = (t: CodexTranscript, sidecar?: unknown) => parseCodex(t.toJsonl(), sidecar === undefined ? {} : { sidecar });
const share = (raw: string, mode: (typeof SHARE_MODES)[number] = "full", sidecar?: unknown) => prepareShare(raw, { mode, config: DEFAULT_CONFIG, harness: "codex", knownSecrets: [], ...(sidecar ? { sidecar } : {}) });
const tools = (steps: { kind: string }[]) => steps.filter((s): s is ToolStep => s.kind === "tool");

/** A small session: a prompt, a commentary line, a code-mode call running two commands at once, an answer. */
function basic(): CodexTranscript {
  return new CodexTranscript()
    .user("fix the flaky test")
    .reason()
    .say("Looking at the test first.", "commentary")
    .exec([
      { cmd: "sed -n 1,40p src/app.test.ts", output: "test body", parsed: [{ type: "read", cmd: "sed -n 1,40p src/app.test.ts", name: "app.test.ts", path: "src/app.test.ts" }] },
      { cmd: "npm test", output: "1 failing", exit: 1 },
    ], { input: 12_000, cached: 9_000, output: 300, reasoning: 120 })
    .say("The test races the timer; fixed by awaiting it.")
    .usage({ input: 13_000, cached: 12_000, output: 80 })
    .complete();
}

describe("codex: detect", () => {
  it("recognises a rollout by its header line, and not `codex exec --json` output", () => {
    expect(detectHarness(basic().toJsonl())).toBe("codex");
    const execJson = ['{"type":"thread.started","thread_id":"01a0c0de-0000-7000-8000-000000000001"}', '{"type":"turn.started"}', '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"hi"}}', '{"type":"turn.completed","usage":{"input_tokens":10,"cached_input_tokens":0,"output_tokens":5}}'].join("\n");
    expect(detectHarness(execJson)).toBeUndefined();
    expect(codex.detect({ type: "session_meta", payload: { id: "x" } })).toBe(false);
    expect(codex.detect({ type: "session_meta", payload: { id: "x", originator: "codex_cli_rs" } })).toBe(true);
  });
});

describe("codex: parse", () => {
  it("takes prompts from what the user typed, marked authored, and drops what Codex injected", () => {
    const { session, dropped } = parse(basic());
    expect(session.harness).toMatchObject({ name: "codex", version: "0.169.0" });
    expect(session.source.sessionId).toBe("01a0c0de-0000-7000-8000-000000000001");
    expect(session.project).toMatchObject({ cwd: "/home/tester/work/demo", branch: "feature/demo" });
    expect(session.turns).toHaveLength(1);
    expect(session.turns[0]!.user).toEqual({ text: "fix the flaky test", authored: true });
    expect(dropped).toMatchObject({ "developer-message": 1, "injected-context": 1, world_state: 1, "encrypted-reasoning": 1 });
  });

  it("shows each command a code-mode call ran as its own tool step, under that call's response, output once", () => {
    const { session } = parse(basic());
    const steps = session.turns[0]!.steps;
    expect(steps.map((s) => s.kind)).toEqual(["thinking", "text", "tool", "tool", "text"]);
    const [read, test] = tools(steps);
    expect(read).toMatchObject({ name: "exec_command", action: "read", files: ["/home/tester/work/demo/src/app.test.ts"], summary: "/home/tester/work/demo/src/app.test.ts", result: { text: "test body" } });
    expect(test).toMatchObject({ name: "exec_command", action: "exec", summary: "npm test", isError: true, result: { text: "1 failing", isError: true } });
    // The thinking, the commentary and both commands belong to the response the first usage record names.
    const first = session.responses[0]!.id;
    expect(steps.slice(0, 4).map((s) => s.responseId)).toEqual([first, first, first, first]);
    expect(steps[4]!.responseId).toBe(session.responses[1]!.id);
    // The script itself, and its output repeating the commands', are not shown.
    expect(JSON.stringify(session.turns)).not.toContain("Promise.allSettled");
    expect(session.stats.toolCalls).toBe(0); // computed by the pipeline
  });

  it("counts usage per response: input without the cached part, reasoning inside output, estimated cost", () => {
    const t = basic();
    const { session } = parse(t);
    expect(session.responses.map((r) => r.usage)).toEqual([
      expect.objectContaining({ input: 3_000, cacheRead: 9_000, output: 300, reasoning: 120, cacheWrite: 0 }),
      expect.objectContaining({ input: 1_000, cacheRead: 12_000, output: 80, reasoning: 0 }),
    ]);
    expect(session.responses.every((r) => r.model === "gpt-6.1-sol")).toBe(true);
    // gpt-6.1-sol: $2 input, $0.10 cached, $10 output per million.
    expect(session.responses[0]!.usage.cost).toBeCloseTo((3_000 * 2 + 9_000 * 0.1 + 300 * 10) / 1e6, 12);
    expect(session.stats.costSource).toBe("estimated");
    const p = share(t.toJsonl());
    const total = p.session.stats.tokens;
    expect(total.input + total.cacheRead).toBe(t.totals.input_tokens);
    expect(total.output).toBe(t.totals.output_tokens);
    expect(p.session.stats.thinking).toMatchObject({ blocks: 1, chars: 0, tokens: 120 });
  });

  it("falls back to token_count events when a file has no usage records, counting each change of the total once", () => {
    const t = new CodexTranscript("01a0c0de-0000-7000-8000-000000000002");
    t.records = false;
    t.user("hi").say("hello").usage({ input: 500, cached: 0, output: 20 }).rateLimits();
    // A repeated total (the same response reported twice) is not a second response.
    t.lines.push({ ...t.lines.at(-2)! });
    t.say("again").usage({ input: 700, cached: 500, output: 10 });
    const { session } = parse(t);
    expect(session.responses.map((r) => [r.usage.input, r.usage.cacheRead, r.usage.output])).toEqual([[500, 0, 20], [200, 500, 10]]);
    expect(session.turns[0]!.steps.map((s) => s.responseId)).toEqual(session.responses.map((r) => r.id));
  });

  it("turns a model or effort switch into events in the turn that uses it", () => {
    const t = new CodexTranscript().user("one").say("a").usage({ input: 100 }).complete();
    t.user("two", { model: "gpt-6.2-sol", effort: "high" }).say("b").usage({ input: 100 }).complete();
    const { session } = parse(t);
    expect(session.models).toEqual(["gpt-6.1-sol", "gpt-6.2-sol"]);
    expect(session.turns[0]!.steps.filter((s) => s.kind === "event")).toEqual([]);
    expect(session.turns[1]!.steps.filter((s) => s.kind === "event").map((s) => s.kind === "event" && [s.event, s.text])).toEqual([
      ["model_change", "Model → gpt-6.2-sol"],
      ["thinking_level", "Reasoning effort → high"],
    ]);
    expect(session.responses[1]!.model).toBe("gpt-6.2-sol");
  });

  it("makes a $skill prompt a command with a skill event, and drops the skill's body", () => {
    const t = new CodexTranscript().user("$review-pr look at #42", { skills: ["review-pr"] }).say("ok").usage({ input: 100 });
    const { session, dropped } = parse(t);
    expect(session.turns[0]!.user).toEqual({ text: "$review-pr look at #42", authored: true, command: { name: "$review-pr", args: "look at #42" } });
    expect(session.turns[0]!.steps[0]).toMatchObject({ kind: "event", event: "skill", skill: { name: "review-pr", invokedBy: "user" } });
    expect(dropped["injected-context"]).toBe(2);
    expect(JSON.stringify(session)).not.toContain("SKILL-BODY-MARKER");
  });

  it("marks a skill the model loaded by reading its SKILL.md", () => {
    const path = "/home/tester/.codex/skills/triage/SKILL.md";
    const t = new CodexTranscript().user("go").exec([{ cmd: `cat ${path}`, output: "---", parsed: [{ type: "read", cmd: `cat ${path}`, name: "SKILL.md", path }] }]);
    const steps = parse(t).session.turns[0]!.steps;
    expect(steps.at(-1)).toMatchObject({ kind: "event", event: "skill", skill: { name: "triage", invokedBy: "model" } });
  });

  it("counts images in a prompt", () => {
    const t = new CodexTranscript().user("what is this?", { images: 2 }).say("a cat").usage({ input: 100 });
    expect(parse(t).session.turns[0]!.user).toMatchObject({ text: "what is this?", images: 2 });
  });

  it("records an interrupt and an error turn as events", () => {
    const t = new CodexTranscript().user("one").complete("unexpected status 400 Bad Request: model not supported\nmore detail");
    t.user("two").say("working", "commentary").exec([{ cmd: "sleep 100" }]).abort();
    const { session } = parse(t);
    expect(session.turns[0]!.steps).toEqual([expect.objectContaining({ kind: "event", event: "error", text: "unexpected status 400 Bad Request: model not supported" })]);
    expect(session.turns[1]!.steps.at(-1)).toMatchObject({ kind: "event", event: "interrupted", text: "Interrupted by user" });
  });

  it("shows a code-mode call that ran no command as the script with its own output", () => {
    const t = new CodexTranscript().user("go").exec([], { input: 500 }, "text('just js')");
    const [step] = tools(parse(t).session.turns[0]!.steps);
    expect(step).toMatchObject({ name: "exec", action: "other", summary: "text('just js')", input: { code: "text('just js')" } });
    expect(step!.result?.text).toContain("Script completed");
    expect(step!.responseId).toBe(parse(t).session.responses[0]!.id);
  });

  it("shows a web search with what it found", () => {
    const t = new CodexTranscript().user("search").webSearch("vitest fake timers", [{ title: "Fake timers", url: "https://example.invalid/timers" }]);
    const [step] = tools(parse(t).session.turns[0]!.steps);
    expect(step).toMatchObject({ name: "web_search", action: "web", summary: "vitest fake timers", result: { text: "Fake timers — https://example.invalid/timers" } });
  });

  it("reads apply_patch as an edit of the files its headers name, and a shell function call once", () => {
    const patch = "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-old\n+new\n*** Add File: src/b.ts\n+x\n*** End Patch";
    const t = new CodexTranscript().user("edit").customTool("apply_patch", patch, "Success. Updated the following files:\nM src/a.ts");
    t.functionCall("shell", { command: ["bash", "-lc", "git status"] }, "clean", { commandItem: { cmd: "git status", output: "clean" } });
    const steps = tools(parse(t).session.turns[0]!.steps);
    expect(steps).toHaveLength(2);
    expect(steps[0]).toMatchObject({ name: "apply_patch", action: "edit", files: ["src/a.ts", "src/b.ts"], result: { text: expect.stringContaining("Success") } });
    expect(steps[1]).toMatchObject({ name: "shell", result: { text: "clean" } });
  });

  it("shows a spawned agent and its message without the encrypted parts", () => {
    const t = new CodexTranscript().user("explore");
    t.functionCall("spawn_agent", { task_name: "explorer", message: encryptedBlob(45) }, '{"agent_path":"/root/explorer"}', { namespace: "collaboration" }).agentMessage();
    const { session, dropped } = parse(t);
    const spawn = session.turns[0]!.steps.find((s): s is SubagentStep => s.kind === "subagent");
    expect(spawn).toMatchObject({ tool: "spawn_agent", agents: ["explorer"], result: { text: '{"agent_path":"/root/explorer"}' } });
    expect(session.turns[0]!.steps.at(-1)).toMatchObject({ kind: "event", event: "subagent_notice", text: "Message from /root/explorer" });
    expect(dropped).toMatchObject({ "encrypted-blob": 1, "agent-message": 1 });
  });

  it("names the session after its title in session_index.jsonl", () => {
    expect(parse(basic(), { title: "Flaky test" }).session.title).toBe("Flaky test");
    expect(parse(basic()).session.title).toBeUndefined();
  });

  it("keeps the token_count fallback when the only usage record is a torn last line", () => {
    const t = new CodexTranscript("01a0c0de-0000-7000-8000-000000000004");
    t.records = false;
    t.user("hi").say("hello").usage({ input: 500, cached: 100, output: 20 });
    const raw = `${t.toJsonl()}{"timestamp":"2026-01-01T00:09:00.000Z","ordinal":99,"type":"token_usage_record","payload":{"usage":{"input_tok`;
    expect(parseCodex(raw).session.responses.map((r) => r.usage.input)).toEqual([400]);
  });

  it("refuses a legacy-format rollout with a fixed message instead of a share without prompts", () => {
    const legacy = new CodexTranscript("01a0c0de-0000-7000-8000-000000000005", "/w", { cliVersion: "0.120.0" });
    (legacy.lines[0]!.payload as Record<string, unknown>).history_mode = "legacy";
    legacy.line("event_msg", { type: "user_message", message: "hello" }).line("event_msg", { type: "agent_message", message: "hi" });
    expect(() => parseCodex(legacy.toJsonl())).toThrow(UnsupportedFormatError);
    expect(() => parseCodex(legacy.toJsonl())).toThrow("legacy history format");
    // No `history_mode` at all, but legacy events and no display items: the same.
    delete (legacy.lines[0]!.payload as Record<string, unknown>).history_mode;
    expect(() => parseCodex(legacy.toJsonl())).toThrow(UnsupportedFormatError);
    expect(toSafeError(new UnsupportedFormatError(LEGACY_MESSAGE))).toEqual({ code: "unsupported-format", message: LEGACY_MESSAGE });
  });

  it("parses a header-only file (an old CLI) and a torn last line", () => {
    expect(parse(new CodexTranscript("01a0c0de-0000-7000-8000-000000000003", "/w", { cliVersion: "0.58.0" })).session.turns).toEqual([]);
    const raw = `${basic().toJsonl()}{"timestamp":"2026-01-01T00:09:00.000Z","type":"event_ms`;
    expect(parseCodex(raw).session.turns).toHaveLength(1);
  });
});

describe("codex: what reaches a share", () => {
  /** A session with every kind of encrypted blob and every kind of context that must never be shared. */
  function everything(): string {
    const t = new CodexTranscript().user("$review-pr go", { skills: ["review-pr"], images: 1 }).reason("Plan: read the diff.", 47).say("ok", "commentary");
    t.exec([{ cmd: "git diff", output: "diff --git a/x b/x" }]);
    t.functionCall("spawn_agent", { task_name: "explorer", message: encryptedBlob(49) }, "{}", { namespace: "collaboration" });
    t.functionCall("send_message", { target: "/root", message: encryptedBlob(51) }, "", { namespace: "collaboration" });
    t.agentMessage().say("done").usage({ input: 100 }).complete();
    t.line("response_item", { type: "additional_tools", tools: [{ name: "ADDITIONAL-TOOLS-MARKER" }] });
    return t.toJsonl();
  }

  it("never lets an encrypted blob, the instructions or the injected context through, in any mode", () => {
    const raw = everything();
    expect(raw).toMatch(/gAAAA/);
    for (const mode of SHARE_MODES) {
      const { json } = share(raw, mode);
      expect(json, mode).not.toMatch(/gAAAA/);
      for (const marker of [BASE_INSTRUCTIONS, AGENTS_MD.split("\n")[0]!, DEVELOPER_TEXT, WORLD_STATE_MARKER, "SKILL-BODY-MARKER", "ADDITIONAL-TOOLS-MARKER", "user-ABCDEFGHIJ", "00000000-1111-2222-3333-444444444444", "danger-full-access"]) {
        expect(json, `${mode}: ${marker}`).not.toContain(marker);
      }
    }
  });

  it("replaces an encrypted blob inside other text (a command that printed a rollout, a script that quotes one)", () => {
    const blob = encryptedBlob(53);
    const t = new CodexTranscript().user("look at the rollout");
    t.exec([{ cmd: "tail -1 rollout.jsonl", output: `{"encrypted_content":"${blob}"}` }]);
    t.exec([], { input: 300 }, `const x = "${blob}";`);
    const { json, session } = share(t.toJsonl());
    expect(json).not.toContain(blob.slice(0, 40));
    const steps = session.turns[0]!.steps as ToolStep[];
    expect(steps[0]!.result?.text).toBe('{"encrypted_content":"[encrypted]"}');
    expect(steps[1]!.input).toEqual({ code: 'const x = "[encrypted]";' });
    // The output, the script and the script's one-line summary.
    expect(session.redaction?.dropped["encrypted-blob"]).toBe(3);
  });

  it("keeps a reasoning summary as thinking text in full mode", () => {
    const { session } = share(everything());
    expect(session.turns[0]!.steps.find((s) => s.kind === "thinking")).toMatchObject({ text: "Plan: read the diff.", blocks: 1 });
  });

  it("works in every share mode, prompts mode included (prompts are authored)", () => {
    const raw = basic().toJsonl();
    for (const mode of SHARE_MODES) {
      const p = share(raw, mode);
      expect(p.report.blocked, mode).toBe(false);
      expect(p.session.turns[0]!.user?.text, mode).toBe("fix the flaky test");
    }
    expect(share(raw, "prompts").session.turns[0]!.steps).toEqual([]);
  });
});

describe("codex: summarize", () => {
  it("collects what the browser shows, without a full parse", () => {
    const t = basic();
    t.user("second", { model: "gpt-6.2-sol" }).say("b").usage({ input: 10 });
    const c = new Collector();
    codex.summarize(t.toJsonl(), c, { title: "Renamed" });
    expect(c.title).toBe("Renamed");
    expect(c.cwd).toBe("/home/tester/work/demo");
    expect(c.branch).toBe("feature/demo");
    expect(c.models).toEqual(["gpt-6.1-sol", "gpt-6.2-sol"]);
    expect(c.promptHead).toEqual(["fix the flaky test", "second"]);
    expect(c.calls).toBe(3);
    expect(c.tools).toEqual({ exec_command: 2 });
    expect(c.reply).toBe("b");
    expect(c.startedAt).toBe("2026-01-01T00:00:02.000Z");
  });
});

describe("codex: files", () => {
  afterEach(() => resetCodexCaches());

  /** A `$CODEX_HOME` with rollouts in the date tree, one archived, one subagent's, and a session index. */
  function home() {
    const dir = mkdtempSync(join(tmpdir(), "codex-home-"));
    const day = join(dir, "sessions", "2026", "01", "01");
    mkdirSync(day, { recursive: true });
    mkdirSync(join(dir, "archived_sessions"));
    const ids = { a: "01a0c0de-0000-7000-8000-00000000000a", b: "01a0c0de-0000-7000-8000-00000000000b", sub: "01a0c0de-0000-7000-8000-00000000000c", old: "01a0c0de-0000-7000-8000-00000000000d" };
    const write = (path: string, t: CodexTranscript) => {
      writeFileSync(path, t.toJsonl());
      return path;
    };
    const files = {
      a: write(join(day, `rollout-2026-01-01T00-00-01-${ids.a}.jsonl`), new CodexTranscript(ids.a, "/work/one").user("first").say("x").usage({ input: 10 })),
      b: write(join(day, `rollout-2026-01-01T00-00-02-${ids.b}.jsonl`), new CodexTranscript(ids.b, "/work/two").user("second")),
      sub: write(join(day, `rollout-2026-01-01T00-00-03-${ids.sub}.jsonl`), new CodexTranscript(ids.sub, "/work/one", { subagent: { parent: ids.a } }).user("child")),
      old: write(join(dir, "archived_sessions", `rollout-2025-12-01T00-00-00-${ids.old}.jsonl`), new CodexTranscript(ids.old, "/work/one").user("archived")),
    };
    writeFileSync(join(day, "notes.txt"), "not a rollout");
    writeFileSync(join(dir, "session_index.jsonl"), [`{"id":"${ids.a}","thread_name":"Old name","updated_at":"2026-01-01T00:00:00Z"}`, `{"id":"${ids.a}","thread_name":"First thread","updated_at":"2026-01-02T00:00:00Z"}`, "{torn"].join("\n"));
    return { dir, root: join(dir, "sessions"), ids, files };
  }

  it("lists top-level rollouts from the date tree and the archive, filtered by working directory, never a subagent's", () => {
    const h = home();
    expect(codex.listFiles(h.root).sort()).toEqual([h.files.a, h.files.b, h.files.old].sort());
    expect(codex.listFiles(h.root, "/work/one").sort()).toEqual([h.files.a, h.files.old].sort());
    expect(codex.listFiles(h.root, "/work/one/")).toHaveLength(2);
    expect(codex.listFiles(h.root, "/elsewhere")).toEqual([]);
    expect(codex.sessionId(h.files.a)).toBe(h.ids.a);
    expect(codex.sessionCwd?.(h.files.b)).toBe("/work/two");
  });

  it("finds the session Codex names in CODEX_THREAD_ID, else the newest for the directory", () => {
    const h = home();
    const roots = { "claude-code": join(h.dir, "none"), pi: join(h.dir, "none"), codex: h.root };
    expect(resolveSession(undefined, { current: true, env: { CODEX_THREAD_ID: h.ids.b }, cwd: "/work/one", roots }).path).toBe(h.files.b);
    utimesSync(h.files.old, new Date(2025, 0, 1), new Date(2025, 0, 1));
    expect(resolveSession(undefined, { current: true, env: {}, cwd: "/work/one", roots }).path).toBe(h.files.a);
    expect(resolveSession(h.ids.b, { roots }).harness).toBe("codex");
  });

  it("refuses to guess when another agent's id is in the environment too, and takes --harness", () => {
    const h = home();
    const projects = join(h.dir, "claude");
    const claudeFile = join(projects, "-work-one", "11111111-2222-3333-4444-555555555555.jsonl");
    mkdirSync(join(projects, "-work-one"), { recursive: true });
    writeFileSync(claudeFile, "{}\n");
    const roots = { "claude-code": projects, pi: join(h.dir, "none"), codex: h.root };
    // Claude Code started Codex (or the other way round): both name a session, and which one runs the command is unknown.
    const env = { CLAUDE_CODE_SESSION_ID: "11111111-2222-3333-4444-555555555555", CODEX_THREAD_ID: h.ids.b };
    expect(() => resolveSession(undefined, { current: true, env, cwd: "/work/one", roots })).toThrow("More than one agent names its current session here (Claude Code, Codex): pass --harness claude-code or --harness codex to say which.");
    expect(resolveSession(undefined, { current: true, env, cwd: "/work/one", roots, harness: "codex" }).path).toBe(h.files.b);
    expect(resolveSession(undefined, { current: true, env, cwd: "/work/one", roots, harness: "claude-code" }).path).toBe(claudeFile);
  });

  it("strips terminal controls from the working directory `list` prints", () => {
    const h = home();
    const evil = "/work/\u001b]52;c;aGk=\u0007x\nfake line";
    writeFileSync(join(h.root, "2026", "01", "01", "rollout-2026-01-01T00-00-09-01a0c0de-0000-7000-8000-0000000000e1.jsonl"), new CodexTranscript("01a0c0de-0000-7000-8000-0000000000e1", evil).user("x").toJsonl());
    const r = spawnSync(process.execPath, ["--import", "tsx", join(import.meta.dirname, "..", "src", "cli.ts"), "list", "--harness", "codex"], { encoding: "utf8", env: { PATH: process.env.PATH ?? "", HOME: h.dir, OVERSHARE_CODEX_SESSIONS: h.root } });
    expect(r.status, r.stderr).toBe(0);
    const row = r.stdout.split("\n").find((l) => l.includes("01a0c0de") && l.includes("/work/"))!;
    expect(row).toContain("/work/");
    expect(r.stdout).not.toMatch(/\u001b|\u0007/);
    expect(r.stdout.split("\n").filter((l) => l.startsWith("fake line"))).toEqual([]);
  });

  it("reads a renamed title from session_index.jsonl (the last entry wins), and the browser index follows a rename", () => {
    const h = home();
    expect(readSession("codex", h.files.a).options.sidecar).toEqual({ title: "First thread" });
    expect(readSession("codex", h.files.b).options.sidecar).toEqual({});
    const cachePath = join(h.dir, "index.json");
    const roots = { "claude-code": join(h.dir, "none"), pi: join(h.dir, "none"), codex: h.root };
    const titleOf = () => buildIndex({ roots, cachePath }).find((s) => s.id === h.ids.a)?.title;
    expect(titleOf()).toBe("First thread");
    writeFileSync(join(h.dir, "session_index.jsonl"), `{"id":"${h.ids.a}","thread_name":"Renamed","updated_at":"2026-01-03T00:00:00Z"}\n`);
    utimesSync(join(h.dir, "session_index.jsonl"), new Date(2026, 1, 1), new Date(2026, 1, 1));
    expect(titleOf()).toBe("Renamed");
  });

  it("takes its login from $CODEX_HOME/auth.json for redaction", () => {
    expect(codex.credentialFiles?.({ CODEX_HOME: "/x/codex" }, "/home/t")).toEqual(["/x/codex/auth.json"]);
    expect(codex.credentialFiles?.({}, "/home/t")).toEqual(["/home/t/.codex/auth.json"]);
    expect(codex.sessionsRoot({ OVERSHARE_CODEX_SESSIONS: "/s" }, "/home/t")).toBe("/s");
    expect(codex.sessionsRoot({ CODEX_HOME: "/x/codex" }, "/home/t")).toBe("/x/codex/sessions");
  });
});

describe("session size limit", () => {
  it("refuses to read a transcript over OVERSHARE_MAX_SESSION_MB, with a message that names sizes only", () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-big-"));
    const file = join(dir, "rollout-2026-01-01T00-00-00-01a0c0de-0000-7000-8000-0000000000ff.jsonl");
    const t = basic();
    while (t.toJsonl().length < 1_100_000) t.say("x".repeat(10_000), "commentary");
    writeFileSync(file, t.toJsonl());
    expect(() => readSession("codex", file, { OVERSHARE_MAX_SESSION_MB: "1" })).toThrow(SessionTooLargeError);
    expect(() => readSession("codex", file, { OVERSHARE_MAX_SESSION_MB: "1" })).toThrow("The session file is 2 MB, more than the 1 MB overshare reads (set OVERSHARE_MAX_SESSION_MB to raise it)");
    expect(readSession("codex", file, {}).raw.length).toBeGreaterThan(1_000_000);
  });

  it("reads a cached browse row again when the size limit now puts the file on the other side", () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-limit-"));
    const day = join(dir, "sessions", "2026", "01", "01");
    mkdirSync(day, { recursive: true });
    const t = basic();
    while (t.toJsonl().length < 1_100_000) t.say("x".repeat(10_000), "commentary");
    writeFileSync(join(day, "rollout-2026-01-01T00-00-00-01a0c0de-0000-7000-8000-0000000000fe.jsonl"), t.toJsonl());
    const opts = { roots: { "claude-code": join(dir, "none"), pi: join(dir, "none"), codex: join(dir, "sessions") }, cachePath: join(dir, "index.json") };
    const prev = process.env.OVERSHARE_MAX_SESSION_MB;
    try {
      delete process.env.OVERSHARE_MAX_SESSION_MB;
      expect(buildIndex(opts)[0]).toMatchObject({ prompts: 1 });
      process.env.OVERSHARE_MAX_SESSION_MB = "1";
      expect(buildIndex(opts)[0]).toMatchObject({ tooLarge: true });
      delete process.env.OVERSHARE_MAX_SESSION_MB;
      expect(buildIndex(opts)[0]?.tooLarge).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.OVERSHARE_MAX_SESSION_MB;
      else process.env.OVERSHARE_MAX_SESSION_MB = prev;
    }
  });

  it("lists a too-large session in the browser as such instead of dropping it", () => {
    const prev = process.env.OVERSHARE_MAX_SESSION_MB;
    process.env.OVERSHARE_MAX_SESSION_MB = "1";
    try {
      const s = summarizeFile({ harness: "codex", id: "big", path: "/nonexistent/never-read.jsonl", mtimeMs: 1, size: 3 * 1024 * 1024 });
      expect(s).toMatchObject({ tooLarge: true, title: "(too large to read: 3 MB; see OVERSHARE_MAX_SESSION_MB)", prompts: 0 });
    } finally {
      if (prev === undefined) delete process.env.OVERSHARE_MAX_SESSION_MB;
      else process.env.OVERSHARE_MAX_SESSION_MB = prev;
    }
  });
});

describe("codex: subagents", () => {
  afterEach(() => resetCodexCaches());
  const PARENT = "01a0c0de-0000-7000-8000-0000000000a0";
  const CHILD = "01a0c0de-0000-7000-8000-0000000000a1";
  const GRANDCHILD = "01a0c0de-0000-7000-8000-0000000000a2";

  /** A parent that spawns `explorer`, whose rollout replays the parent's history and then does its own work. */
  function family() {
    const parent = new CodexTranscript(PARENT, "/work/one").user("map the repo").say("Spawning an explorer.", "commentary").usage({ input: 2_000, cached: 0, output: 30 });
    parent.spawn("explorer", CHILD).agentMessage("/root/explorer").say("The explorer found two packages.").usage({ input: 3_000, cached: 2_000, output: 50 }).complete();
    const child = new CodexTranscript(CHILD, "/work/one", { subagent: { parent: PARENT } });
    // The replayed parent history: its prompt and a usage record that is the parent's, not the child's.
    child.user("map the repo").say("Spawning an explorer.", "commentary").usage({ input: 2_000, cached: 0, output: 30 });
    child.startOwnHistory();
    child.exec([{ cmd: "ls packages", output: "a b" }], { input: 5_000, cached: 4_000, output: 100 }).say("Two packages: a and b.").usage({ input: 5_500, cached: 5_000, output: 40 });
    const grandchild = new CodexTranscript(GRANDCHILD, "/work/one", { subagent: { parent: CHILD, task: "reader" } }).startOwnHistory().turnContext().say("read a").usage({ input: 700, cached: 0, output: 7 });
    return { parent, child, grandchild };
  }

  function homeWith(f: ReturnType<typeof family>) {
    const dir = mkdtempSync(join(tmpdir(), "codex-sub-"));
    const day = join(dir, "sessions", "2026", "01", "01");
    mkdirSync(day, { recursive: true });
    const path = (id: string, n: number) => join(day, `rollout-2026-01-01T00-00-0${n}-${id}.jsonl`);
    writeFileSync(path(PARENT, 1), f.parent.toJsonl());
    writeFileSync(path(CHILD, 2), f.child.toJsonl());
    writeFileSync(path(GRANDCHILD, 3), f.grandchild.toJsonl());
    return { root: join(dir, "sessions"), parent: path(PARENT, 1), child: path(CHILD, 2) };
  }

  it("finds the rollouts a session's agents wrote (their own too), and keeps them out of the list", () => {
    const h = homeWith(family());
    expect(codex.listFiles(h.root)).toEqual([h.parent]);
    expect(codex.subagents?.count(h.parent, PARENT)).toBe(2);
    expect(codex.subagents?.load(h.parent).map((f) => f.fileName)).toEqual([`rollout-2026-01-01T00-00-02-${CHILD}.jsonl`, `rollout-2026-01-01T00-00-03-${GRANDCHILD}.jsonl`]);
    expect(codex.subagents?.count(h.child, CHILD)).toBe(1);
  });

  it("puts the agents' own spend on the spawn step, never the history they replayed, and their answer as its result", () => {
    const h = homeWith(family());
    const { raw, options } = readSession("codex", h.parent);
    const p = share(raw, "full");
    const shared = prepareShare(raw, { mode: "full", config: DEFAULT_CONFIG, harness: "codex", knownSecrets: [], ...options });
    const spawn = shared.session.turns[0]!.steps.find((s): s is SubagentStep => s.kind === "subagent")!;
    // Child: 1,000 + 500 uncached, 4,000 + 5,000 cached, 140 output; grandchild: 700 uncached, 7 output.
    expect(spawn.usage).toMatchObject({ input: 2_200, cacheRead: 9_000, output: 147, turns: 3, toolUses: 1, nested: 1, models: ["gpt-6.1-sol"] });
    expect(spawn.usage!.cost).toBeCloseTo((2_200 * 2 + 9_000 * 0.1 + 147 * 10) / 1e6, 12);
    expect(spawn.result?.text).toBe("Two packages: a and b.");
    expect(spawn.async).toBe(true);
    expect(shared.session.stats.subagentUsage).toMatchObject({ agents: 2, responses: 3, tokens: { input: 2_200, cacheRead: 9_000, output: 147 } });
    expect(shared.session.stats.subagentUsage?.unlinked).toBeUndefined();
    // The parent's own usage is unchanged by its agents, and without the files there are no subagent figures.
    expect(shared.session.stats.tokens).toEqual(p.session.stats.tokens);
    expect(p.session.stats.subagentUsage).toBeUndefined();
    expect(shared.json).not.toMatch(/gAAAA/);
  });

  it("links overlapping spawns by call id, whatever their task names and the order they start in", () => {
    const A = "01a0c0de-0000-7000-8000-0000000000d1";
    const B = "01a0c0de-0000-7000-8000-0000000000d2";
    const parent = new CodexTranscript(PARENT, "/work/one").user("two at once");
    const first = parent.spawnCall("alpha");
    const second = parent.spawnCall("beta");
    // Started in the other order, with agent paths that do not end in the task names.
    parent.spawnStarted(second, B, "/root/agent_2").spawnStarted(first, A, "/root/agent_1").spawnOutput(first, "/root/agent_1").spawnOutput(second, "/root/agent_2");
    const child = (id: string, answer: string, input: number) => new CodexTranscript(id, "/work/one", { subagent: { parent: PARENT } }).startOwnHistory().turnContext().say(answer).usage({ input });
    const { session } = parseCodex(parent.toJsonl(), { subagentFiles: [{ fileName: "a.jsonl", raw: child(A, "alpha answer", 111).toJsonl() }, { fileName: "b.jsonl", raw: child(B, "beta answer", 222).toJsonl() }] });
    const spawns = session.turns[0]!.steps.filter((s): s is SubagentStep => s.kind === "subagent");
    expect(spawns.map((s) => [s.agents[0], s.result?.text, s.usage?.input])).toEqual([["alpha", "alpha answer", 111], ["beta", "beta answer", 222]]);
  });

  it("does not take an interrupted agent's last progress note as its answer", () => {
    const parent = new CodexTranscript(PARENT, "/work/one").user("go").spawn("explorer", CHILD);
    const child = new CodexTranscript(CHILD, "/work/one", { subagent: { parent: PARENT } }).startOwnHistory().turnContext().say("Done with part one.").say("Now checking the tests…", "commentary").usage({ input: 300 }).abort();
    const spawn = parseCodex(parent.toJsonl(), { subagentFiles: [{ fileName: "c.jsonl", raw: child.toJsonl() }] }).session.turns[0]!.steps.find((s): s is SubagentStep => s.kind === "subagent")!;
    expect(spawn.result?.text).toBe('{"agent_path":"/root/explorer"}');
    expect(spawn.usage?.input).toBe(300);
  });

  it("counts a child's token_count fallback when its only usage record is torn", () => {
    const parent = new CodexTranscript(PARENT, "/work/one").user("go").spawn("explorer", CHILD);
    const child = new CodexTranscript(CHILD, "/work/one", { subagent: { parent: PARENT } }).startOwnHistory().turnContext();
    child.records = false;
    child.say("ok").usage({ input: 400, cached: 100 });
    const raw = `${child.toJsonl()}{"timestamp":"2026-01-01T00:09:00.000Z","ordinal":99,"type":"token_usage_record","payload":{"usage":{"input_t`;
    const spawn = parseCodex(parent.toJsonl(), { subagentFiles: [{ fileName: "c.jsonl", raw }] }).session.turns[0]!.steps.find((s): s is SubagentStep => s.kind === "subagent")!;
    expect(spawn.usage).toMatchObject({ input: 300, cacheRead: 100, turns: 1 });
  });

  it("finds child rollouts under a sessions root with any name (OVERSHARE_CODEX_SESSIONS)", () => {
    const f = family();
    const dir = mkdtempSync(join(tmpdir(), "codex-custom-"));
    const day = join(dir, "my-rollouts", "2026", "01", "01");
    mkdirSync(day, { recursive: true });
    const parentFile = join(day, `rollout-2026-01-01T00-00-01-${PARENT}.jsonl`);
    writeFileSync(parentFile, f.parent.toJsonl());
    writeFileSync(join(day, `rollout-2026-01-01T00-00-02-${CHILD}.jsonl`), f.child.toJsonl());
    expect(codex.subagents?.count(parentFile, PARENT)).toBe(1);
  });

  it("marks a child rollout's replayed history inherited when it is opened on its own", () => {
    const f = family();
    const { session } = parseCodex(f.child.toJsonl());
    expect(session.responses.map((r) => [r.usage.input, r.inherited ?? false])).toEqual([[2_000, true], [1_000, false], [500, false]]);
    const st = share(f.child.toJsonl()).session.stats;
    expect(st.tokens).toMatchObject({ input: 1_500, cacheRead: 9_000 });
    expect(st.inherited).toMatchObject({ responses: 1, tokens: { input: 2_000 } });
  });
});

describe("codex: compaction", () => {
  it("shows a checkpoint as a compaction with its summary, counts its call, and calls the next prompt a rebuild", () => {
    const t = new CodexTranscript().user("long task").say("a").usage({ input: 100_000, cached: 0, output: 100 }).say("b").usage({ input: 101_000, cached: 99_840, output: 100 });
    // The summary call (usage with no reply of its own), then the checkpoint.
    t.usage({ input: 101_500, cached: 100_864, output: 2_000 }).compacted("Summary: we were refactoring the parser.");
    t.say("c").usage({ input: 12_000, cached: 0, output: 50 }).complete();
    const p = share(t.toJsonl());
    const steps = p.session.turns[0]!.steps;
    expect(steps.find((s) => s.kind === "event" && s.event === "compaction")).toMatchObject({ text: "Context compacted", detail: "Summary: we were refactoring the parser." });
    expect(p.session.responses.map((r) => r.purpose)).toEqual([undefined, undefined, "compaction", undefined]);
    expect(p.session.stats.compactions).toBe(1);
    // The first call after the compaction re-reads a rebuilt context: expected, not a miss.
    expect(p.session.responses[3]!.cacheEvent).toMatchObject({ kind: "rebuild" });
    expect(p.session.stats.cache).toMatchObject({ misses: 0, rebuilds: 1 });
    expect(p.json).not.toContain("REPLACED-HISTORY-MARKER");
    expect(p.session.redaction?.dropped["compacted-history"]).toBe(1);
  });

  it("keeps compaction output out of the replies and finds the compaction call by the id the checkpoint names", () => {
    const t = new CodexTranscript().user("long task").say("a").usage({ input: 100_000, cached: 0, output: 100 });
    // Codex 0.169: the summary is written as output first, then the usage record, then the checkpoint naming it.
    const id = t.nextResponseId;
    t.compactionOutput("COMPACTION-SUMMARY-OUTPUT").usage({ input: 100_500, cached: 99_840, output: 2_000 }).compacted("Summary: refactoring.", id);
    t.say("b").usage({ input: 12_000, cached: 0, output: 50 }).complete();
    const p = share(t.toJsonl());
    expect(p.session.turns[0]!.steps.filter((s) => s.kind === "text").map((s) => s.kind === "text" && s.text)).toEqual(["a", "b"]);
    expect(p.json).not.toContain("COMPACTION-SUMMARY-OUTPUT");
    expect(p.session.responses.find((r) => r.id === id)?.purpose).toBe("compaction");
    expect(p.session.redaction?.dropped["compaction-output"]).toBe(1);
  });

  it("takes a ContextCompaction item as the compaction when the rollout has no checkpoint line", () => {
    const t = new CodexTranscript().user("go").say("a").usage({ input: 100 });
    t.line("event_msg", { type: "item_completed", item: { type: "ContextCompaction", id: "cc1" } });
    expect(parseCodex(t.toJsonl()).session.turns[0]!.steps.at(-1)).toMatchObject({ kind: "event", event: "compaction" });
  });
});

describe("codex: compressed rollouts and continuation files", () => {
  afterEach(() => resetCodexCaches());
  const T = "01a0c0de-0000-7000-8000-0000000000b0";
  const R = "01a0c0de-0000-7000-8000-0000000000b9";

  function dirs() {
    const dir = mkdtempSync(join(tmpdir(), "codex-zst-"));
    const day = join(dir, "sessions", "2026", "01", "02");
    mkdirSync(day, { recursive: true });
    return { dir, day, root: join(dir, "sessions") };
  }

  it("reads a .jsonl.zst rollout like a plain one, and prefers the plain file while both exist", () => {
    const d = dirs();
    const t = basic();
    const zst = join(d.day, `rollout-2026-01-02T00-00-00-${T}.jsonl.zst`);
    writeFileSync(zst, zstdCompressSync(Buffer.from(t.toJsonl())));
    expect(codex.listFiles(d.root)).toEqual([zst]);
    expect(codex.listFiles(d.root, "/home/tester/work/demo")).toEqual([zst]);
    expect(codex.sessionId(zst)).toBe(T);
    expect(sniffHarness(zst)).toBe("codex");
    const { raw, options } = readSession("codex", zst);
    expect(raw).toBe(t.toJsonl());
    expect(parseCodex(raw, options).session.turns[0]!.user?.text).toBe("fix the flaky test");
    expect(summarizeFile({ harness: "codex", id: T, path: zst, mtimeMs: 1, size: 10 })).toMatchObject({ prompts: 1, cwd: "/home/tester/work/demo" });
    // While Codex switches representations both files exist: the plain one is the session.
    const plain = zst.slice(0, -".zst".length);
    writeFileSync(plain, t.toJsonl());
    resetCodexCaches();
    expect(codex.listFiles(d.root)).toEqual([plain]);
  });

  it("holds a compressed rollout to the size limit once decompressed", () => {
    const d = dirs();
    const t = basic();
    while (t.toJsonl().length < 1_200_000) t.say("x".repeat(10_000), "commentary");
    const zst = join(d.day, `rollout-2026-01-02T00-00-00-${T}.jsonl.zst`);
    writeFileSync(zst, zstdCompressSync(Buffer.from(t.toJsonl())));
    expect(() => readSession("codex", zst, { OVERSHARE_MAX_SESSION_MB: "1" })).toThrow(SessionTooLargeError);
    const prev = process.env.OVERSHARE_MAX_SESSION_MB;
    process.env.OVERSHARE_MAX_SESSION_MB = "1";
    try {
      expect(summarizeFile({ harness: "codex", id: T, path: zst, mtimeMs: 1, size: 5_000 })).toMatchObject({ tooLarge: true, title: "(too large to read once decompressed; see OVERSHARE_MAX_SESSION_MB)" });
    } finally {
      if (prev === undefined) delete process.env.OVERSHARE_MAX_SESSION_MB;
      else process.env.OVERSHARE_MAX_SESSION_MB = prev;
    }
  });

  /** A thread reverted after its first turn: the original rollout, and a continuation that keeps its first turn. */
  function reverted(base = T, own = T) {
    const original = new CodexTranscript(base).user("first prompt").say("first answer").usage({ input: 1_000, cached: 0, output: 10 }).complete();
    const keep = original.toJsonl();
    original.user("abandoned prompt").say("abandoned answer").usage({ input: 2_000, cached: 1_000, output: 20 }).complete();
    const cont = new CodexTranscript(own);
    (cont.lines[0]!.payload as Record<string, unknown>).history_base = { thread_id: base, end_ordinal_exclusive: keep.split("\n").length - 1, end_byte_offset: Buffer.byteLength(keep) };
    if (own !== base) (cont.lines[0]!.payload as Record<string, unknown>).forked_from_id = base;
    cont.user("second prompt").say("second answer").usage({ input: 1_500, cached: 1_000, output: 15 }).complete();
    return { original, cont };
  }

  it("lists a reverted thread once, as its newest rollout, read with the history it kept", () => {
    const d = dirs();
    const { original, cont } = reverted();
    const a = join(d.day, `rollout-2026-01-02T00-00-00-${T}.jsonl`);
    const b = join(d.day, `rollout-2026-01-02T00-10-00-${T}_${R}.jsonl`);
    writeFileSync(a, original.toJsonl());
    writeFileSync(b, cont.toJsonl());
    utimesSync(a, new Date(2026, 0, 2), new Date(2026, 0, 2));
    expect(codex.listFiles(d.root)).toEqual([b]);
    expect(codex.sessionId(b)).toBe(T);
    expect(codex.currentSession?.({ CODEX_THREAD_ID: T }, d.root, "/x")).toBe(b);
    const { raw, options } = readSession("codex", b);
    const p = prepareShare(raw, { mode: "full", config: DEFAULT_CONFIG, harness: "codex", knownSecrets: [], ...options });
    expect(p.session.turns.map((t) => t.user?.text)).toEqual(["first prompt", "second prompt"]);
    expect(p.json).not.toContain("abandoned");
    // Kept history of the same thread is this session's own spend.
    expect(p.session.stats.tokens).toMatchObject({ input: 1_000 + 500, cacheRead: 1_000 });
    expect(p.session.stats.inherited).toBeUndefined();
  });

  it("counts history kept from another thread (a fork) as inherited", () => {
    const d = dirs();
    const F = "01a0c0de-0000-7000-8000-0000000000c0";
    const { original, cont } = reverted(T, F);
    writeFileSync(join(d.day, `rollout-2026-01-02T00-00-00-${T}.jsonl`), original.toJsonl());
    const fork = join(d.day, `rollout-2026-01-02T00-10-00-${F}.jsonl`);
    writeFileSync(fork, cont.toJsonl());
    const { raw, options } = readSession("codex", fork);
    const p = prepareShare(raw, { mode: "full", config: DEFAULT_CONFIG, harness: "codex", knownSecrets: [], ...options });
    expect(p.session.source.sessionId).toBe(F);
    expect(p.session.stats.tokens).toMatchObject({ input: 500, cacheRead: 1_000 });
    expect(p.session.stats.inherited).toMatchObject({ responses: 1, tokens: { input: 1_000 } });
  });

  it("cuts a kept prefix at its byte offset, also in a compressed rollout with non-ASCII text before the cut", () => {
    const d = dirs();
    const { original, cont } = reverted();
    // Multi-byte text in the kept part makes characters and bytes differ.
    (original.lines[1]!.payload as Record<string, unknown>).thread_id = "é".repeat(200);
    const keep = original.toJsonl().split("\n").slice(0, original.lines.length - 9).join("\n") + "\n";
    expect(original.toJsonl().startsWith(keep)).toBe(true);
    (cont.lines[0]!.payload as Record<string, unknown>).history_base = { thread_id: T, end_ordinal_exclusive: 0, end_byte_offset: Buffer.byteLength(keep) };
    writeFileSync(join(d.day, `rollout-2026-01-02T00-00-00-${T}.jsonl.zst`), zstdCompressSync(Buffer.from(original.toJsonl())));
    const b = join(d.day, `rollout-2026-01-02T00-10-00-${T}_${R}.jsonl`);
    writeFileSync(b, cont.toJsonl());
    const { raw, options } = readSession("codex", b);
    const history = (options.sidecar as { history: { raw: string }[] }).history;
    expect(history[0]!.raw).toBe(keep);
    expect(prepareShare(raw, { mode: "full", config: DEFAULT_CONFIG, harness: "codex", knownSecrets: [], ...options }).json).not.toContain("abandoned");
  });

  it("picks a thread's current rollout by its name's start time, whatever the mtimes, and filters by cwd after", () => {
    const d = dirs();
    const { original, cont } = reverted();
    (cont.lines[0]!.payload as Record<string, unknown>).cwd = "/work/elsewhere";
    const a = join(d.day, `rollout-2026-01-02T00-00-00-${T}.jsonl`);
    const b = join(d.day, `rollout-2026-01-02T00-10-00-${T}_${R}.jsonl`);
    writeFileSync(a, original.toJsonl());
    writeFileSync(b, cont.toJsonl());
    for (const f of [a, b]) utimesSync(f, new Date(2026, 0, 2), new Date(2026, 0, 2));
    expect(codex.listFiles(d.root)).toEqual([b]);
    expect(codex.currentSession?.({ CODEX_THREAD_ID: T }, d.root, "/x")).toBe(b);
    // The older rollout's cwd does not bring it back as the thread's session.
    expect(codex.listFiles(d.root, "/home/tester/work/demo")).toEqual([]);
    expect(codex.listFiles(d.root, "/work/elsewhere")).toEqual([b]);
  });

  it("summarizes a continuation with its kept prompts, and re-reads it when its kept rollout appears", () => {
    const d = dirs();
    const { original, cont } = reverted();
    const b = join(d.day, `rollout-2026-01-02T00-10-00-${T}_${R}.jsonl`);
    writeFileSync(b, cont.toJsonl());
    const key = codex.sidecar!.key(b);
    writeFileSync(join(d.day, `rollout-2026-01-02T00-00-00-${T}.jsonl`), original.toJsonl());
    resetCodexCaches();
    expect(codex.sidecar!.key(b)).not.toBe(key);
    const s = summarizeFile({ harness: "codex", id: T, path: b, mtimeMs: 1, size: 1 });
    expect(s.promptHead).toEqual(["first prompt", "second prompt"]);
  });

  it("holds a continuation and its kept history to one size budget, and lists it as too large in the browser", () => {
    const d = dirs();
    const { original, cont } = reverted();
    while (original.toJsonl().length < 700_000) original.say("x".repeat(10_000), "commentary");
    (cont.lines[0]!.payload as Record<string, unknown>).history_base = { thread_id: T, end_ordinal_exclusive: 0, end_byte_offset: Buffer.byteLength(original.toJsonl()) };
    while (cont.toJsonl().length < 500_000) cont.say("y".repeat(10_000), "commentary");
    writeFileSync(join(d.day, `rollout-2026-01-02T00-00-00-${T}.jsonl`), original.toJsonl());
    const b = join(d.day, `rollout-2026-01-02T00-10-00-${T}_${R}.jsonl`);
    writeFileSync(b, cont.toJsonl());
    const prev = process.env.OVERSHARE_MAX_SESSION_MB;
    process.env.OVERSHARE_MAX_SESSION_MB = "1";
    try {
      expect(() => readSession("codex", b)).toThrow(SessionTooLargeError);
      expect(summarizeFile({ harness: "codex", id: T, path: b, mtimeMs: 1, size: 500_000 })).toMatchObject({ tooLarge: true });
    } finally {
      if (prev === undefined) delete process.env.OVERSHARE_MAX_SESSION_MB;
      else process.env.OVERSHARE_MAX_SESSION_MB = prev;
    }
  });

  it("reads a compressed row again when the size limit changes (its size on disk says nothing about it)", () => {
    const d = dirs();
    const t = basic();
    while (t.toJsonl().length < 1_200_000) t.say("x".repeat(10_000), "commentary");
    writeFileSync(join(d.day, `rollout-2026-01-02T00-00-00-${T}.jsonl.zst`), zstdCompressSync(Buffer.from(t.toJsonl())));
    const opts = { roots: { "claude-code": join(d.dir, "none"), pi: join(d.dir, "none"), codex: d.root }, cachePath: join(d.dir, "index.json") };
    const prev = process.env.OVERSHARE_MAX_SESSION_MB;
    try {
      delete process.env.OVERSHARE_MAX_SESSION_MB;
      expect(buildIndex(opts)[0]?.tooLarge).toBeUndefined();
      process.env.OVERSHARE_MAX_SESSION_MB = "1";
      expect(buildIndex(opts)[0]).toMatchObject({ tooLarge: true });
      delete process.env.OVERSHARE_MAX_SESSION_MB;
      expect(buildIndex(opts)[0]?.tooLarge).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.OVERSHARE_MAX_SESSION_MB;
      else process.env.OVERSHARE_MAX_SESSION_MB = prev;
    }
  });

  it("reads a continuation whose kept rollout is missing as itself alone", () => {
    const d = dirs();
    const { cont } = reverted();
    const b = join(d.day, `rollout-2026-01-02T00-10-00-${T}_${R}.jsonl`);
    writeFileSync(b, cont.toJsonl());
    const { raw, options } = readSession("codex", b);
    expect(parseCodex(raw, options).session.turns.map((t) => t.user?.text)).toEqual(["second prompt"]);
  });
});
