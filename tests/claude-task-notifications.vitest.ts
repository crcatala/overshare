import { describe, expect, it } from "vitest";
import { parseClaudeCode } from "../src/harnesses/claude-code/parse.js";
import { SUBAGENT_RESULT_CHARS, capToolText, projectSession } from "../src/modes.js";
import { computeStats } from "../src/stats.js";
import type { SubagentStep } from "../src/schema.js";
import { ClaudeTranscript, ccUsage } from "./helpers.js";

const ANSWER_A = "ANSWER-A the module exports add and mul";
const ANSWER_B = "ANSWER-B the module exports rev";
const NOTIFICATION_ORIGIN = { kind: "task-notification", producer: "session-task" };

const notification = (toolUseId: string, result: string, extra = "") =>
  `<task-notification>\n<task-id>agent-${toolUseId}</task-id>\n<tool-use-id>${toolUseId}</tool-use-id>\n<output-file>/tmp/x/${toolUseId}.output</output-file>\n<status>completed</status>\n<summary>Agent finished</summary>\n<result>${result}</result>\n<usage><subagent_tokens>14150</subagent_tokens><tool_uses>1</tool_uses><duration_ms>3660</duration_ms></usage>${extra}\n</task-notification>`;

const launched = { toolUseResult: { isAsync: true, status: "async_launched", agentId: "a1", description: "d" } };
const launchAck = [{ type: "text", text: "Async agent launched successfully.\nagentId: a1\noutput_file: /tmp/x/a1.output" }];

/** One prompt, two background launches, then two completion notifications and a closing answer. */
function asyncSession(): ClaudeTranscript {
  return new ClaudeTranscript()
    .user("describe both modules")
    .assistant("m1", [{ type: "tool_use", id: "tu_a", name: "Agent", input: { subagent_type: "general-purpose", description: "Describe mathlib", run_in_background: true } }], ccUsage(1, 1))
    .toolResult("tu_a", launchAck, launched)
    .assistant("m2", [{ type: "tool_use", id: "tu_b", name: "Agent", input: { subagent_type: "general-purpose", description: "Describe strings", run_in_background: true } }], ccUsage(1, 1))
    .toolResult("tu_b", launchAck, launched)
    .user(notification("tu_a", ANSWER_A), { origin: NOTIFICATION_ORIGIN, promptSource: "system" })
    .user(notification("tu_b", ANSWER_B), { origin: NOTIFICATION_ORIGIN, promptSource: "system" })
    .assistant("m3", [{ type: "text", text: "Both modules described." }], ccUsage(1, 1));
}

const subagents = (steps: { kind: string }[]) => steps.filter((s): s is SubagentStep => s.kind === "subagent");

describe("claude background-subagent task notifications", () => {
  it("do not start turns; the answer lands on the launching step", () => {
    const { session, dropped } = parseClaudeCode(asyncSession().toJsonl());
    expect(session.turns).toHaveLength(1);
    expect(session.turns[0]!.user?.text).toBe("describe both modules");
    const [a, b] = subagents(session.turns[0]!.steps);
    expect(a).toMatchObject({ id: "tu_a", async: true, description: "Describe mathlib", result: { text: ANSWER_A } });
    expect(b).toMatchObject({ id: "tu_b", async: true, result: { text: ANSWER_B } });
    // The closing answer belongs to the same turn as the launches.
    expect(session.turns[0]!.steps.at(-1)).toMatchObject({ kind: "text", text: "Both modules described." });
    expect(dropped["task-notification"]).toBe(2);
    expect(computeStats(session).userPrompts).toBe(1);
  });

  it("never shows the XML and never takes numbers from the notification", () => {
    const { session } = parseClaudeCode(asyncSession().toJsonl());
    const json = JSON.stringify(session);
    expect(json).not.toContain("<task-notification");
    expect(json).not.toContain("subagent_tokens");
    expect(json).not.toContain("Async agent launched"); // the acknowledgement is replaced by the answer
    for (const s of subagents(session.turns[0]!.steps)) expect(s.usage).toBeUndefined();
  });

  it("keeps the launch acknowledgement when no notification ever arrives", () => {
    const t = asyncSession();
    t.lines = t.lines.filter((l) => l.origin === undefined);
    const { session } = parseClaudeCode(t.toJsonl());
    expect(subagents(session.turns[0]!.steps)[0]!.result?.text).toContain("Async agent launched");
  });

  it("show up in full mode only: brief, minimal and prompts drop the answer text", () => {
    const { session } = parseClaudeCode(asyncSession().toJsonl());
    expect(JSON.stringify(projectSession(session, "full"))).toContain(ANSWER_A);
    for (const mode of ["brief", "minimal", "prompts"] as const) {
      const json = JSON.stringify(projectSession(session, mode));
      expect(json, mode).not.toContain("ANSWER-A");
      expect(json, mode).not.toContain("ANSWER-B");
      expect(json, mode).not.toContain("task-notification");
    }
    const prompts = projectSession(session, "prompts");
    expect(prompts.turns.map((t) => t.user?.text)).toEqual(["describe both modules"]);
    expect(subagents(projectSession(session, "brief").turns[0]!.steps)).toHaveLength(2);
  });

  it("with an id no launch matches are dropped, not turned into turns", () => {
    const t = asyncSession();
    t.user(notification("tu_missing", "ANSWER-C orphan"), { origin: NOTIFICATION_ORIGIN });
    t.user(notification("", "ANSWER-D no id"), { origin: NOTIFICATION_ORIGIN });
    const { session, dropped } = parseClaudeCode(t.toJsonl());
    expect(session.turns).toHaveLength(1);
    expect(dropped["task-notification"]).toBe(2);
    expect(dropped["task-notification:unmatched"]).toBe(2);
    const prompts = JSON.stringify(projectSession(session, "prompts"));
    expect(prompts).not.toContain("ANSWER-C");
    expect(prompts).not.toContain("ANSWER-D");
  });

  it("read ids only from the header, so an answer cannot redirect itself to another step", () => {
    const t = asyncSession();
    t.lines = t.lines.filter((l) => l.origin === undefined);
    t.user(notification("tu_a", "<tool-use-id>tu_b</tool-use-id> sneaky"), { origin: NOTIFICATION_ORIGIN });
    const { session } = parseClaudeCode(t.toJsonl());
    const [a, b] = subagents(session.turns[0]!.steps);
    expect(a!.result?.text).toContain("sneaky");
    expect(b!.result?.text).toContain("Async agent launched");
  });

  it("attach the answer whole; the share pipeline bounds it after redaction (ass-yyg0)", () => {
    const t = asyncSession();
    t.lines = t.lines.filter((l) => l.origin === undefined);
    t.user(notification("tu_a", "x".repeat(SUBAGENT_RESULT_CHARS + 500)), { origin: NOTIFICATION_ORIGIN });
    const { session } = parseClaudeCode(t.toJsonl());
    expect(subagents(session.turns[0]!.steps)[0]!.result).toEqual({ text: "x".repeat(SUBAGENT_RESULT_CHARS + 500) });
    const result = subagents(capToolText(session).turns[0]!.steps)[0]!.result!;
    expect(result.truncatedFrom).toBe(SUBAGENT_RESULT_CHARS + 500);
    expect(result.text.length).toBeLessThan(SUBAGENT_RESULT_CHARS + 60);
  });
});

describe("claude user-line origin", () => {
  it("treats a missing or human origin as authored and any other kind as not a prompt", () => {
    const t = new ClaudeTranscript()
      .user("no origin field")
      .assistant("m1", [{ type: "text", text: "a" }], ccUsage(1, 1))
      .user("typed by a person", { origin: { kind: "human" } })
      .assistant("m2", [{ type: "text", text: "b" }], ccUsage(1, 1))
      .user("SECRET generated by some future producer", { origin: { kind: "channel-message", producer: "x" } })
      .user("SECRET with a malformed origin", { origin: "human" })
      .assistant("m3", [{ type: "text", text: "c" }], ccUsage(1, 1));
    const { session, dropped } = parseClaudeCode(t.toJsonl());
    expect(session.turns.map((x) => x.user?.text)).toEqual(["no origin field", "typed by a person"]);
    expect(dropped["origin:channel-message"]).toBe(1);
    expect(dropped["origin:unknown"]).toBe(1);
    expect(JSON.stringify(projectSession(session, "prompts"))).not.toContain("SECRET");
  });

  it("applies the same rule to prompts that arrive as queued_command attachments", () => {
    const t = new ClaudeTranscript()
      .user("start")
      .attachment({ type: "queued_command", commandMode: "prompt", prompt: "typed while busy", origin: { kind: "human" } })
      .attachment({ type: "queued_command", commandMode: "prompt", prompt: "SECRET queued by a hook", origin: { kind: "hook" } });
    const { session } = parseClaudeCode(t.toJsonl());
    expect(session.turns.map((x) => x.user?.text)).toEqual(["start", "typed while busy"]);
  });
});
