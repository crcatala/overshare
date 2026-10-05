import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { detectHarness } from "../src/harnesses/index.js";
import { parsePi } from "../src/harnesses/pi/parse.js";
import { projectSession } from "../src/modes.js";
import { PI_INPUT_PROVENANCE_TYPE } from "../src/schema.js";
import { computeStats } from "../src/stats.js";
import { PiTranscript, piUsage } from "./helpers.js";

describe("pi adapter", () => {
  it("exports the current branch of the session tree", () => {
    const t = new PiTranscript();
    t.entry("model_change", { provider: "test", modelId: "m1" });
    t.user("first").assistant([{ type: "text", text: "a1" }]);
    const fork = t.lastId;
    t.user("old branch").assistant([{ type: "text", text: "a2" }]);
    const oldLeaf = t.lastId!;
    t.branchFrom(fork).user("new branch").assistant([{ type: "text", text: "a3" }]);

    expect(parsePi(t.toJsonl()).session.turns.map((x) => x.user?.text)).toEqual(["first", "new branch"]);
    expect(parsePi(t.toJsonl(), { leafId: oldLeaf }).session.turns.map((x) => x.user?.text)).toEqual(["first", "old branch"]);
    expect(detectHarness(t.toJsonl())).toBe("pi");
  });

  it("maps tool calls, results, thinking and per-response cost", () => {
    const t = new PiTranscript().user("edit it");
    t.assistant(
      [
        { type: "thinking", thinking: "plan the edit", thinkingSignature: "x" },
        { type: "toolCall", id: "c1", name: "read", arguments: { path: "/home/tester/work/demo/a.ts" } },
        { type: "toolCall", id: "c2", name: "edit", arguments: { path: "src/b.ts", edits: [] } },
      ],
      piUsage(100, 20, 500, 0, 0.01, 5),
    )
      .toolResult("c1", "read", "file body")
      .toolResult("c2", "edit", "no match", undefined, true)
      .assistant([{ type: "text", text: "done" }], piUsage(50, 10, 600, 0, 0.02), { stopReason: "stop" });
    const { session } = parsePi(t.toJsonl());
    const steps = session.turns[0]!.steps;
    expect(steps.map((s) => s.kind)).toEqual(["thinking", "tool", "tool", "text"]);
    expect(steps[0]).toMatchObject({ text: "plan the edit", chars: 13, tokens: 5 });
    expect(steps[1]).toMatchObject({ name: "read", action: "read", files: ["/home/tester/work/demo/a.ts"], result: { text: "file body" } });
    expect(steps[2]).toMatchObject({ name: "edit", isError: true });
    const stats = computeStats(session);
    expect(stats).toMatchObject({ toolCalls: 2, toolErrors: 1, costSource: "per-response", files: { read: 1, edited: 1, written: 0 } });
    expect(stats.cost).toBeCloseTo(0.03);
  });

  it("records model/thinking changes only after the first prompt, plus compaction and errors", () => {
    const t = new PiTranscript();
    t.entry("model_change", { provider: "p", modelId: "start" });
    t.entry("thinking_level_change", { thinkingLevel: "high" });
    t.user("go");
    t.entry("model_change", { provider: "p", modelId: "switched" });
    t.entry("compaction", { summary: "summary text", tokensBefore: 200000, firstKeptEntryId: "x" });
    t.assistant([], piUsage(1, 0), { stopReason: "error", errorMessage: "rate limited\nretry later" });
    const events = parsePi(t.toJsonl()).session.turns.flatMap((x) => x.steps);
    expect(events.map((e) => (e.kind === "event" ? `${e.event}:${e.text}` : e.kind))).toEqual([
      "model_change:Model → p/switched",
      "compaction:Context compacted",
      "error:rate limited",
    ]);
  });

  it("detects subagent runs but leaves management calls as ordinary tools", () => {
    const t = new PiTranscript().user("delegate");
    t.assistant([
      { type: "toolCall", id: "s1", name: "subagent", arguments: { action: "list" } },
      {
        type: "toolCall",
        id: "s2",
        name: "subagent",
        arguments: {
          async: "true",
          workflowScript: "return runs.all([{key:'a', agent:'scout', task:'x'}, {key:'b', agent: \"reviewer\"}])",
          mission: JSON.stringify({ title: "Audit the parser" }),
        },
      },
    ])
      .toolResult("s1", "subagent", "[]", { mode: "management", results: [] })
      .toolResult("s2", "subagent", "Workflow completed", {
        mode: "workflow",
        totalChildUsage: { input: 1000, output: 200, cacheRead: 5000, cacheWrite: 0, cost: 0.5, turns: 12 },
      });
    t.entry("custom_message", { customType: "subagent-notify", content: "Background task completed: **workflow**\n\nmore", display: false });
    const { session } = parsePi(t.toJsonl());
    const steps = session.turns[0]!.steps;
    expect(steps[0]).toMatchObject({ kind: "tool", name: "subagent", summary: '{"action":"list"}' });
    expect(steps[1]).toMatchObject({
      kind: "subagent",
      agents: ["scout", "reviewer"],
      description: "Audit the parser",
      async: true,
      mode: "workflow",
      usage: { input: 1000, output: 200, cacheRead: 5000, cost: 0.5, turns: 12 },
    });
    expect(steps[2]).toMatchObject({ kind: "event", event: "subagent_notice", text: "Background task completed: **workflow**" });
    expect(computeStats(session)).toMatchObject({ subagents: 1, toolCalls: 2 });
  });

  it("uses session_info as the title and header metadata", () => {
    const t = new PiTranscript();
    t.entry("session_info", { name: "My pi session" });
    t.user("hi");
    const { session } = parsePi(t.toJsonl());
    expect(session.turns[0]!.user).toMatchObject({ text: "hi", authored: false });
    expect(session).toMatchObject({
      title: "My pi session",
      harness: { name: "pi", formatVersion: 3 },
      source: { sessionId: "01a0aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee" },
      project: { name: "demo" },
    });
  });
});

function provenance(stored: string, original: string, timestamp: number, patch: Record<string, unknown> = {}) {
  return { customType: PI_INPUT_PROVENANCE_TYPE, data: {
    version: 1, text: original, source: "interactive", messageTimestamp: timestamp,
    messageHash: createHash("sha256").update(stored).digest("hex"), ...patch,
  } };
}

describe("pi authored-input provenance", () => {
  function transcript(stored = "expanded private instructions", original = "/review src/invoices") {
    const t = new PiTranscript();
    const timestamp = 1_700_000_000_000;
    const provenanceId = t.entry("custom", provenance(stored, original, timestamp));
    const messageId = t.entry("message", { message: { role: "user", content: [{ type: "text", text: stored }], timestamp } });
    return { t, timestamp, provenanceId, messageId };
  }

  it("replaces stored expansion with slash input and strips it in prompts mode", () => {
    const { t } = transcript();
    const { session } = parsePi(t.toJsonl());
    expect(session.turns[0]!.user).toEqual({
      text: "/review src/invoices", authored: true, command: { name: "/review", args: "src/invoices" },
      expanded: "expanded private instructions",
    });
    const prompts = projectSession(session, "prompts");
    expect(JSON.stringify(prompts)).not.toContain("expanded private instructions");
    expect(prompts.turns[0]!.user).toMatchObject({ text: "/review src/invoices", authored: true });
  });

  it("does not verify input recorded under the pre-rename marker (agent-share)", () => {
    const t = new PiTranscript();
    const timestamp = 1_700_000_000_000;
    t.entry("custom", { ...provenance("expanded private instructions", "/review src/invoices", timestamp), customType: "agent-share:authored-input" });
    t.entry("message", { message: { role: "user", content: [{ type: "text", text: "expanded private instructions" }], timestamp } });
    const { session } = parsePi(t.toJsonl());
    expect(session.turns[0]!.user?.authored).not.toBe(true);
  });

  it("keeps unchanged verified input and strips image-only expansions", () => {
    const { t } = transcript("typed by the user", "typed by the user");
    expect(parsePi(t.toJsonl()).session.turns[0]!.user).toEqual({ text: "typed by the user", authored: true });
    const image = new PiTranscript();
    const timestamp = 1_700_000_000_001;
    image.entry("custom", provenance("", "/review", timestamp));
    image.entry("message", { message: { role: "user", content: [{ type: "image", data: "x", mimeType: "image/png" }], timestamp } });
    const parsed = parsePi(image.toJsonl()).session;
    expect(parsed.turns[0]!.user).toMatchObject({ text: "/review", authored: true, images: 1 });
    expect(projectSession(parsed, "prompts").turns[0]!.user).not.toHaveProperty("expanded");
  });

  it("ignores provenance that is not the immediate parent on the selected branch", () => {
    const { t } = transcript();
    const unrelated = t.entry("model_change", { provider: "p", modelId: "other" });
    t.forkAfter(unrelated).entry("message", {
      message: { role: "user", content: [{ type: "text", text: "expanded private instructions" }], timestamp: 1_700_000_000_000 },
    });
    const current = parsePi(t.toJsonl()).session;
    expect(current.turns.at(-1)!.user).toMatchObject({ text: "expanded private instructions", authored: false });
    expect(JSON.stringify(current.turns.at(-1))).not.toContain("/review src/invoices");
    expect(() => projectSession(current, "prompts")).toThrow(/no verified pre-expansion input/);
  });

  it.each([
    ["hash mismatch", (source: PiTranscript) => { source.lines[2]!.message.content[0].text = "changed after capture"; }],
    ["timestamp mismatch", (source: PiTranscript) => { source.lines[2]!.message.timestamp += 1; }],
    ["extension source", (source: PiTranscript, timestamp: number) => {
      source.lines[1] = { ...source.lines[1], data: { ...provenance("expanded private instructions", "/review", timestamp, { source: "extension" }).data } };
    }],
    ["unsupported version", (source: PiTranscript, timestamp: number) => {
      source.lines[1] = { ...source.lines[1], data: { ...provenance("expanded private instructions", "/review", timestamp, { version: 2 }).data } };
    }],
  ])("fails closed for %s provenance", (_name, mutate) => {
    const { t, timestamp } = transcript();
    mutate(t, timestamp);
    const parsed = parsePi(t.toJsonl()).session;
    expect(parsed.turns[0]!.user?.authored).toBe(false);
    expect(parsed.turns[0]!.user?.text).not.toBe("/review");
    expect(() => projectSession(parsed, "prompts")).toThrow(/no verified pre-expansion input/);
  });
});

describe("pi adapter: malformed tool calls", () => {
  // ass-3llz: the same crash as in the Claude Code adapter, through the shared TurnBuilder.
  it.each([["an object", { n: "bash" }], ["a number", 7], ["null", null], ["missing", undefined]])("tolerates a toolCall whose name is %s", (_what, name) => {
    const t = new PiTranscript().user("go").assistant([{ type: "toolCall", id: "c1", name, arguments: { command: "ls" } }]).toolResult("c1", "bash", "ok");
    const tool = parsePi(t.toJsonl()).session.turns[0]!.steps.find((s) => s.kind === "tool");
    expect(tool).toMatchObject({ name: "unknown", action: "other", result: { text: "ok" } });
  });
});
