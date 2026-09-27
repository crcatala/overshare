import { describe, expect, it } from "vitest";
import { detectHarness } from "../src/adapters/index.js";
import { parsePi } from "../src/adapters/pi.js";
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
    expect(session).toMatchObject({
      title: "My pi session",
      harness: { name: "pi", formatVersion: 3 },
      source: { sessionId: "01a0aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee" },
      project: { name: "demo" },
    });
  });
});
