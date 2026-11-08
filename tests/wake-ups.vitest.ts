import { describe, expect, it } from "vitest";
import { parseClaudeCode } from "../src/harnesses/claude-code/parse.js";
import { parsePi } from "../src/harnesses/pi/parse.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { SUMMARY_MAX, prepareShare } from "../src/pipeline.js";
import { renderMarkdown } from "../src/markdown.js";
import { projectSession } from "../src/modes.js";
import type { EventStep, NormalizedSession, Step, Turn } from "../src/schema.js";
import { ClaudeTranscript, PiTranscript, ccUsage } from "./helpers.js";

/**
 * A wake-up: the agent finished its reply, then a message the harness or an extension injected started another reply
 * with no prompt. The agent finished more than once in the turn, so minimal keeps the last two replies it finished on.
 */

const NOTIFICATION_ORIGIN = { kind: "task-notification", producer: "session-task" };

const bashNotification = (toolUseId: string, status: string, summary: string) =>
  `<task-notification>\n<task-id>b${toolUseId}</task-id>\n<tool-use-id>${toolUseId}</tool-use-id>\n<output-file>/tmp/x/${toolUseId}.output</output-file>\n<status>${status}</status>\n<summary>${summary}</summary>\n</task-notification>`;

const agentNotification = (toolUseId: string, result: string) =>
  `<task-notification>\n<task-id>agent-${toolUseId}</task-id>\n<tool-use-id>${toolUseId}</tool-use-id>\n<status>completed</status>\n<summary>Agent "Describe mathlib" completed</summary>\n<result>${result}</result>\n</task-notification>`;

/** Every line of the last response carries `stop_reason`, as current Claude Code writes it. */
function stop(t: ClaudeTranscript, reason: string): ClaudeTranscript {
  const id = (t.lines.at(-1)!.message as { id: string }).id;
  for (const line of t.lines) {
    const message = line.message as { id?: string; stop_reason?: string } | undefined;
    if (line.type === "assistant" && message?.id === id) message.stop_reason = reason;
  }
  return t;
}

const texts = (steps: Step[]) => steps.filter((s) => s.kind === "text").map((s) => (s as { text: string }).text);
const events = (steps: Step[]) => steps.filter((s): s is EventStep => s.kind === "event");
const lastTurn = (s: NormalizedSession): Turn => s.turns.at(-1)!;

/**
 * The shape of the session behind the report: the agent waits on a benchmark monitor and stops; the monitor wakes it, it
 * writes the report; minutes later a stopped background job wakes it again.
 */
function strayJobSession(): ClaudeTranscript {
  const t = new ClaudeTranscript().user("benchmark the tokenizer and write up a report");
  stop(t.assistant("m1", [{ type: "tool_use", id: "bg1", name: "Bash", input: { command: "bench.sh", run_in_background: true } }], ccUsage(1, 1)), "tool_use");
  t.toolResult("bg1", "Command running in background with ID: b1");
  stop(t.assistant("m1b", [{ type: "text", text: "Waiting on the benchmark monitor." }], ccUsage(1, 1)), "end_turn");
  t.user(bashNotification("mon1", "completed", "Monitor finished"), { origin: NOTIFICATION_ORIGIN });
  stop(t.assistant("m2", [{ type: "tool_use", id: "p1", name: "Bash", input: { command: "npm run report" } }], ccUsage(1, 1)), "tool_use");
  t.toolResult("p1", "docs/benchmark.md");
  stop(t.assistant("m3", [{ type: "thinking", thinking: "", signature: "s" }, { type: "text", text: "The report is written: docs/benchmark.md" }], ccUsage(1, 1)), "end_turn");
  t.user(bashNotification("bg1", "killed", 'Background command "bench.sh --secret-flag" was stopped'), { origin: NOTIFICATION_ORIGIN });
  stop(t.assistant("m4", [{ type: "text", text: "That stopped job was the first benchmark run; nothing to do." }], ccUsage(1, 1)), "end_turn");
  return t;
}

describe("Claude Code wake-ups", () => {
  it("mark a notification that reaches a finished agent, and keep its summary as full-mode detail", () => {
    const { session } = parseClaudeCode(strayJobSession().toJsonl());
    expect(session.turns).toHaveLength(1);
    const [monitor, stray] = events(lastTurn(session).steps);
    expect(monitor).toMatchObject({ event: "notification", text: "Background task completed", wake: true, detail: "Monitor finished" });
    expect(stray).toMatchObject({ event: "notification", text: "Background task killed", wake: true, detail: 'Background command "bench.sh --secret-flag" was stopped' });
    // Each wake-up sits between the reply the agent finished on and the work it caused.
    const kinds = lastTurn(session).steps.map((s) => (s.kind === "event" ? "wake" : s.kind));
    expect(kinds).toEqual(["tool", "text", "wake", "tool", "thinking", "text", "wake", "text"]);
  });

  it("brief keeps the wake-up without its detail; minimal keeps both closing replies around one marker", () => {
    const { session } = parseClaudeCode(strayJobSession().toJsonl());
    const brief = projectSession(session, "brief");
    expect(events(lastTurn(brief).steps).map((e) => [e.text, e.wake])).toEqual([
      ["Background task completed", true],
      ["Background task killed", true],
    ]);
    expect(JSON.stringify(brief)).not.toContain("secret-flag");

    const minimal = projectSession(session, "minimal");
    const steps = lastTurn(minimal).steps;
    // Not "Waiting on the benchmark monitor.": the report was written after the first wake-up.
    expect(texts(steps)).toEqual(["The report is written: docs/benchmark.md", "That stopped job was the first benchmark run; nothing to do."]);
    expect(steps.at(-2)).toMatchObject({ kind: "event", event: "notification", text: "Resumed after a background update", wake: true });
    expect(steps.at(-2)).not.toHaveProperty("detail");
    // Stepping down from a brief share (what the viewer does) gives the same.
    const fromBrief = lastTurn(projectSession(brief, "minimal")).steps;
    expect(fromBrief.filter((s) => s.kind !== "toolGroup")).toEqual(steps.filter((s) => s.kind !== "toolGroup"));
  });

  it("prompts mode keeps none of it", () => {
    const { session } = parseClaudeCode(strayJobSession().toJsonl());
    const json = JSON.stringify(projectSession(session, "prompts"));
    expect(json).not.toContain("Background task");
    expect(json).not.toContain("report is written");
  });

  it("a background agent reporting to a finished agent is a subagent notice that wakes it", () => {
    const t = new ClaudeTranscript().user("describe mathlib");
    stop(t.assistant("m1", [{ type: "tool_use", id: "tu_a", name: "Agent", input: { subagent_type: "general-purpose", description: "Describe mathlib", run_in_background: true } }], ccUsage(1, 1)), "tool_use");
    t.toolResult("tu_a", [{ type: "text", text: "Async agent launched successfully." }], { toolUseResult: { isAsync: true, status: "async_launched", agentId: "a1" } });
    stop(t.assistant("m2", [{ type: "text", text: "I started an agent; I'll report back." }], ccUsage(1, 1)), "end_turn");
    t.user(agentNotification("tu_a", "ANSWER mathlib exports add"), { origin: NOTIFICATION_ORIGIN });
    stop(t.assistant("m3", [{ type: "text", text: "mathlib exports add." }], ccUsage(1, 1)), "end_turn");
    const { session } = parseClaudeCode(t.toJsonl());
    expect(events(lastTurn(session).steps)).toEqual([expect.objectContaining({ event: "subagent_notice", text: "Background agent completed", wake: true })]);
    expect(texts(lastTurn(projectSession(session, "minimal")).steps)).toEqual(["I started an agent; I'll report back.", "mathlib exports add."]);
  });

  it("a notification while the agent is still working is a plain notice, and minimal keeps only the last reply", () => {
    const t = new ClaudeTranscript().user("run it");
    stop(t.assistant("m1", [{ type: "text", text: "Starting." }, { type: "tool_use", id: "x1", name: "Bash", input: { command: "make" } }], ccUsage(1, 1)), "tool_use");
    t.toolResult("x1", "ok");
    t.user(bashNotification("bg0", "completed", "done"), { origin: NOTIFICATION_ORIGIN });
    stop(t.assistant("m2", [{ type: "text", text: "Done." }], ccUsage(1, 1)), "end_turn");
    const { session } = parseClaudeCode(t.toJsonl());
    const [event] = events(lastTurn(session).steps);
    expect(event).toMatchObject({ event: "notification", text: "Background task completed" });
    expect(event!.wake).toBeUndefined();
    const minimal = lastTurn(projectSession(session, "minimal")).steps;
    expect(texts(minimal)).toEqual(["Done."]);
    expect(events(minimal)).toEqual([]);
  });

  it("older transcripts without stop_reason: a response ending in a tool call is not finished", () => {
    const t = new ClaudeTranscript()
      .user("go")
      .assistant("m1", [{ type: "tool_use", id: "x1", name: "Bash", input: { command: "make" } }], ccUsage(1, 1))
      .user(bashNotification("bg0", "completed", "done"), { origin: NOTIFICATION_ORIGIN })
      .toolResult("x1", "ok")
      .assistant("m2", [{ type: "text", text: "Built." }], ccUsage(1, 1))
      .user(bashNotification("bg1", "completed", "done"), { origin: NOTIFICATION_ORIGIN })
      .assistant("m3", [{ type: "text", text: "The other job finished too." }], ccUsage(1, 1));
    const { session } = parseClaudeCode(t.toJsonl());
    expect(events(lastTurn(session).steps).map((e) => e.wake ?? false)).toEqual([false, true]);
  });

  it("a notification answered only by a new prompt did not wake the agent", () => {
    const t = new ClaudeTranscript().user("one");
    stop(t.assistant("m1", [{ type: "text", text: "First." }], ccUsage(1, 1)), "end_turn");
    t.user(bashNotification("bg0", "completed", "done"), { origin: NOTIFICATION_ORIGIN });
    t.user("two");
    stop(t.assistant("m2", [{ type: "text", text: "Second." }], ccUsage(1, 1)), "end_turn");
    const { session } = parseClaudeCode(t.toJsonl());
    expect(session.turns).toHaveLength(2);
    expect(events(session.turns[0]!.steps)[0]!.wake).toBeUndefined();
    expect(texts(projectSession(session, "minimal").turns[0]!.steps)).toEqual(["First."]);
  });

  it("after an interrupt, a notification that starts a reply is a wake-up", () => {
    const t = new ClaudeTranscript().user("go");
    stop(t.assistant("m1", [{ type: "text", text: "Working on it." }, { type: "tool_use", id: "x1", name: "Bash", input: { command: "sleep 99" } }], ccUsage(1, 1)), "tool_use");
    t.toolResult("x1", "interrupted", {}, true);
    t.user([{ type: "text", text: "[Request interrupted by user for tool use]" }]);
    t.user(bashNotification("bg0", "completed", "done"), { origin: NOTIFICATION_ORIGIN });
    stop(t.assistant("m2", [{ type: "text", text: "The background build finished." }], ccUsage(1, 1)), "end_turn");
    const { session } = parseClaudeCode(t.toJsonl());
    expect(events(lastTurn(session).steps).find((e) => e.event === "notification")).toMatchObject({ wake: true });
  });

  it("a monitor event carries no status, so it is an update, not a finish", () => {
    const t = new ClaudeTranscript().user("watch the benchmark");
    stop(t.assistant("m1", [{ type: "text", text: "Waiting on the benchmark monitor." }], ccUsage(1, 1)), "end_turn");
    t.user(`<task-notification>\n<task-id>bmon1</task-id>\n<summary>Monitor event: "benchmark progress"</summary>\n<event>main: 300/719</event>\n</task-notification>`, { origin: NOTIFICATION_ORIGIN });
    stop(t.assistant("m2", [{ type: "text", text: "300 of 719 frames so far." }], ccUsage(1, 1)), "end_turn");
    const { session, dropped } = parseClaudeCode(t.toJsonl());
    expect(events(lastTurn(session).steps)).toEqual([expect.objectContaining({ text: "Background task update", detail: 'Monitor event: "benchmark progress"', wake: true })]);
    expect(dropped).not.toHaveProperty("task-notification:unmatched");
  });

  it("a notice that a tool result follows before any reply did not wake the agent", () => {
    // Out of the usual order (a malformed or interleaved transcript): the reply answers the tool result.
    const t = new ClaudeTranscript().user("go");
    stop(t.assistant("m1", [{ type: "text", text: "Checking." }], ccUsage(1, 1)), "end_turn");
    t.user(bashNotification("bg0", "completed", "done"), { origin: NOTIFICATION_ORIGIN });
    t.toolResult("late", "late output");
    stop(t.assistant("m2", [{ type: "text", text: "Done." }], ccUsage(1, 1)), "end_turn");
    const { session } = parseClaudeCode(t.toJsonl());
    expect(events(lastTurn(session).steps)[0]!.wake).toBeUndefined();
    expect(texts(lastTurn(projectSession(session, "minimal")).steps)).toEqual(["Done."]);
  });

  it("the summary is capped like other one-line texts when shared, and is in full mode only", () => {
    const long = `Background command "${"x".repeat(400)}" was stopped`;
    const t = new ClaudeTranscript().user("go");
    stop(t.assistant("m1", [{ type: "text", text: "Done." }], ccUsage(1, 1)), "end_turn");
    t.user(bashNotification("bg0", "killed", long), { origin: NOTIFICATION_ORIGIN });
    stop(t.assistant("m2", [{ type: "text", text: "Stray job." }], ccUsage(1, 1)), "end_turn");
    const share = (mode: "full" | "brief") =>
      prepareShare(t.toJsonl(), { mode, config: DEFAULT_CONFIG, harness: "claude-code", machine: { homeDir: "/home/tester", username: "tester", hostname: "box" }, knownSecrets: [] });
    const full = share("full");
    const event = events(lastTurn(full.session).steps)[0]!;
    expect(event.detail!.length).toBeLessThanOrEqual(SUMMARY_MAX);
    expect(event.detail!.endsWith("…")).toBe(true);
    expect(full.report.dropped).not.toHaveProperty("task-notification:unmatched");
    expect(share("brief").json).not.toContain("xxxxxxxx");
  });

  it("a harness message from an unknown producer is shown by its kind, never its text", () => {
    const t = new ClaudeTranscript().user("go");
    stop(t.assistant("m1", [{ type: "text", text: "Done." }], ccUsage(1, 1)), "end_turn");
    t.user("SECRET channel text", { origin: { kind: "channel-message", producer: "x" } });
    t.user("SECRET odd kind", { origin: { kind: "<b>weird</b>" } });
    stop(t.assistant("m2", [{ type: "text", text: "Noted." }], ccUsage(1, 1)), "end_turn");
    const { session } = parseClaudeCode(t.toJsonl());
    expect(events(lastTurn(session).steps).map((e) => [e.text, e.wake])).toEqual([
      ["Harness message (channel-message)", true],
      ["Harness message (unknown)", true],
    ]);
    expect(JSON.stringify(session)).not.toContain("SECRET");
    expect(lastTurn(projectSession(session, "minimal")).steps.at(-2)).toMatchObject({ text: "Resumed after 2 background updates" });
  });
});

describe("pi wake-ups", () => {
  const stopped = (t: PiTranscript, text: string) => t.assistant([{ type: "text", text }], undefined, { stopReason: "stop" });

  it("a subagent notice after the agent finished wakes it; one after a tool result does not", () => {
    const t = new PiTranscript().user("review the tickets");
    t.assistant([{ type: "toolCall", id: "s1", name: "subagent", arguments: { agent: "scout", task: "x", async: "true" } }]);
    t.toolResult("s1", "subagent", "started");
    t.entry("custom_message", { customType: "subagent-notify", content: "Scout is halfway", display: true });
    stopped(t, "I started a scout and will report back.");
    t.entry("custom_message", { customType: "subagent-notify", content: "Background task completed: **scout**\n\nfull answer", display: true });
    stopped(t, "Here is what the scout found.");
    const { session } = parsePi(t.toJsonl());
    expect(events(lastTurn(session).steps).map((e) => [e.text, e.wake ?? false])).toEqual([
      ["Scout is halfway", false],
      ["Background task completed: **scout**", true],
    ]);
    expect(texts(lastTurn(projectSession(session, "minimal")).steps)).toEqual(["I started a scout and will report back.", "Here is what the scout found."]);
  });

  it("another extension's message is shown by its type only when it woke the agent", () => {
    const t = new PiTranscript().user("watch the trigger file");
    t.assistant([{ type: "toolCall", id: "r1", name: "read", arguments: { path: "a" } }]);
    t.toolResult("r1", "read", "a");
    t.entry("custom_message", { customType: "claude-rules", content: "SECRET injected rules", display: false });
    stopped(t, "Watching.");
    t.entry("custom_message", { customType: "file-trigger", content: "External trigger: SECRET payload", display: true });
    stopped(t, "The trigger asked for a rebuild; done.");
    const { session, dropped } = parsePi(t.toJsonl());
    expect(events(lastTurn(session).steps)).toEqual([expect.objectContaining({ event: "notification", text: "Extension message (file-trigger)", wake: true })]);
    expect(JSON.stringify(session)).not.toContain("SECRET");
    expect(dropped["custom_message:claude-rules"]).toBe(1);
    expect(dropped["custom_message:file-trigger"]).toBe(1);
  });

  it("an extension message keeps its place among the notices after it", () => {
    const t = new PiTranscript().user("watch");
    stopped(t, "Watching.");
    t.entry("custom_message", { customType: "file-trigger", content: "External trigger", display: true });
    t.entry("custom_message", { customType: "subagent-notify", content: "Scout done", display: true });
    stopped(t, "Handled both.");
    const { session } = parsePi(t.toJsonl());
    expect(events(lastTurn(session).steps).map((e) => [e.text, e.wake])).toEqual([
      ["Extension message (file-trigger)", true],
      ["Scout done", true],
    ]);
    const minimal = lastTurn(projectSession(session, "minimal")).steps;
    // The marker takes the first wake-up's place and time.
    expect(minimal.at(-2)).toMatchObject({ id: events(lastTurn(session).steps)[0]!.id, text: "Resumed after 2 background updates" });
  });

  it("an extension message that a prompt follows, not a reply, is left out", () => {
    const t = new PiTranscript().user("one");
    stopped(t, "First.");
    t.entry("custom_message", { customType: "file-trigger", content: "queued for later", display: true });
    t.user("two");
    stopped(t, "Second.");
    const { session } = parsePi(t.toJsonl());
    expect(session.turns.flatMap((turn) => events(turn.steps))).toEqual([]);
  });

  it("several wake-ups: minimal keeps the last two replies the agent finished on", () => {
    const t = new PiTranscript().user("run the campaign");
    stopped(t, "Campaign started; I'll report back.");
    for (let i = 1; i <= 3; i++) {
      t.entry("custom_message", { customType: "subagent-notify", content: `Stage ${i} done`, display: true });
      stopped(t, i < 3 ? `Still waiting (${i}/3).` : "All three stages merged.");
    }
    const { session } = parsePi(t.toJsonl());
    const steps = lastTurn(projectSession(session, "minimal")).steps;
    expect(texts(steps)).toEqual(["Still waiting (2/3).", "All three stages merged."]);
    expect(steps.at(-2)).toMatchObject({ event: "notification", text: "Resumed after a background update", wake: true });
  });
});

describe("minimal closing replies", () => {
  /** A turn built directly, to cover the shapes the parsers can produce. */
  function projected(steps: Step[]): Step[] {
    const session = { ...parsePi(new PiTranscript().user("x").toJsonl()).session, mode: "full" as const };
    session.turns = [{ index: 0, user: { text: "x" }, steps }];
    return projectSession(session, "minimal").turns[0]!.steps;
  }
  const text = (id: string, t: string): Step => ({ kind: "text", id, text: t });
  const wake = (id: string): Step => ({ kind: "event", id, event: "subagent_notice", text: "done", wake: true });

  it("without a wake-up keeps only the last reply, as before", () => {
    expect(texts(projected([text("t1", "a"), text("t2", "b")]))).toEqual(["b"]);
  });

  it("a wake-up answered only with tool calls keeps the earlier reply and no marker", () => {
    const steps = projected([text("t1", "Done."), wake("e1"), { kind: "tool", id: "x", name: "Read", input: {} } as Step]);
    expect(texts(steps)).toEqual(["Done."]);
    expect(events(steps)).toEqual([]);
  });

  it("counts the wake-ups between the two replies, including ones answered only with tool calls", () => {
    const tool = (id: string) => ({ kind: "tool", id, name: "Read", input: {} }) as Step;
    const steps = projected([text("t1", "a"), wake("e1"), text("t2", "b"), wake("e2"), tool("x1"), wake("e3"), text("t3", "c"), wake("e4")]);
    expect(texts(steps)).toEqual(["b", "c"]);
    expect(events(steps)).toEqual([expect.objectContaining({ id: "e2", text: "Resumed after 2 background updates" })]);
  });

  it("a wake-up with no reply before it keeps the marker and the last reply", () => {
    const steps = projected([wake("e1"), text("t1", "Results.")]);
    expect(steps.map((s) => s.kind)).toEqual(["event", "text"]);
    expect(steps[0]).toMatchObject({ id: "e1", text: "Resumed after a background update" });
  });
});

describe("markdown", () => {
  it("writes each wake-up in a brief turn before the reply it caused, and no other notice", () => {
    const t = strayJobSession();
    t.user("next");
    stop(t.assistant("m5", [{ type: "text", text: "Starting." }, { type: "tool_use", id: "x9", name: "Bash", input: { command: "make" } }], ccUsage(1, 1)), "tool_use");
    t.toolResult("x9", "ok");
    t.user(bashNotification("bg9", "completed", "mid-work"), { origin: NOTIFICATION_ORIGIN });
    stop(t.assistant("m6", [{ type: "text", text: "Built." }], ccUsage(1, 1)), "end_turn");
    const { session } = parseClaudeCode(t.toJsonl());
    const md = renderMarkdown(projectSession(session, "brief"));
    expect(md.indexOf("_— Background task completed —_")).toBeGreaterThan(md.indexOf("Waiting on the benchmark monitor."));
    expect(md.indexOf("_— Background task killed —_")).toBeGreaterThan(md.indexOf("The report is written"));
    expect(md.indexOf("That stopped job")).toBeGreaterThan(md.indexOf("_— Background task killed —_"));
    // The mid-work notice in the second turn is not a wake-up, so it is not written.
    expect(md.match(/_— Background task/g)).toHaveLength(2);
  });

  it("writes the wake-up between the two replies of a minimal turn", () => {
    const { session } = parseClaudeCode(strayJobSession().toJsonl());
    const md = renderMarkdown(projectSession(session, "minimal"));
    const live = md.indexOf("The report is written");
    const marker = md.indexOf("_— Resumed after a background update —_");
    const stray = md.indexOf("That stopped job");
    expect(live).toBeGreaterThan(-1);
    expect(marker).toBeGreaterThan(live);
    expect(stray).toBeGreaterThan(marker);
  });
});
