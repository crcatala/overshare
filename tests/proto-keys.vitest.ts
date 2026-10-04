/**
 * A key the transcript names `__proto__` is kept (ass-i02w).
 *
 * Records built with bracket assignment (`rates[model] ??= {}`, `tools[name] = ...`) set the record's prototype instead of an
 * own key when the name is `__proto__`, so the entry vanished from `stats.rates`, `stats.tools`, `subagentUsage.byModel`, the
 * dropped-entry counts and the report copies. Each site below runs the real pipeline over a transcript that names a model,
 * tool or entry type `__proto__` and checks the entry survives as an own key with its figure, in the payload and in the report.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.js";
import type { SubagentFileInput } from "../src/adapters/shared.js";
import { prepareShare } from "../src/pipeline.js";
import { safeKeys } from "../src/redact/labels.js";
import { Redactor } from "../src/redact/index.js";
import { SHARE_MODES } from "../src/schema.js";
import { summarizeRaw } from "../src/sessions/summary.js";
import { ClaudeTranscript, PiTranscript, ccUsage } from "./helpers.js";

const P = "__proto__";
const machine = { homeDir: "/home/tester", username: "tester", hostname: "box" };
const prepare = (raw: string, harness: "claude-code" | "pi", mode: (typeof SHARE_MODES)[number], subagentFiles?: SubagentFileInput[]) =>
  prepareShare(raw, { mode, config: DEFAULT_CONFIG, harness, machine, knownSecrets: [], subagentFiles });
/** An own `__proto__` entry, not the prototype `Object.prototype` that a bare read of the name finds. */
const has = (record: object | undefined): boolean => !!record && Object.hasOwn(record, P);
const parsed = (json: string) => JSON.parse(json) as { stats: { tools: Record<string, number>; rates?: Record<string, unknown> } };

const piCost = { input: 0.3, cacheRead: 0.03, cacheWrite: 0.375, output: 1.5, total: 2.2 };
function piSession(model: string, tool: string): string {
  return new PiTranscript()
    .user("go")
    .assistant([{ type: "toolCall", id: "c1", name: tool, arguments: { path: "/home/tester/work/demo/a.ts" } }], { input: 100_000, output: 1000, cacheRead: 1_000_000, cacheWrite: 1000, totalTokens: 1_102_000, cost: piCost }, { model })
    .toolResult("c1", tool, "ok")
    .toJsonl();
}

// pi cannot publish `prompts` without a verified pre-expansion input, which this plain transcript does not carry.
describe.each(["full", "brief"] as const)("a model or tool named __proto__ in a pi transcript (%s)", (mode) => {
  it("keeps its stats.rates entry, in the payload and in the report", () => {
    const { session, json, report } = prepare(piSession(P, P), "pi", mode);
    expect(has(session.stats.rates)).toBe(true);
    expect(has(parsed(json).stats.rates)).toBe(true);
    expect(has(report.stats.rates)).toBe(true);
    expect(Object.getPrototypeOf(session.stats.rates)).toBe(Object.prototype);
    expect(Object.hasOwn(session.stats.rates!, P) && session.stats.rates![P]).toMatchObject({ input: 3, cacheRead: 0.03 });
  });

  it("keeps its stats.tools entry, counted", () => {
    const { session, json, report } = prepare(piSession(P, P), "pi", mode);
    expect(Object.entries(session.stats.tools)).toEqual([[P, 1]]);
    expect(Object.entries(parsed(json).stats.tools)).toEqual([[P, 1]]);
    expect(Object.entries(report.stats.tools)).toEqual([[P, 1]]);
  });
});

describe("two models, one of them named __proto__", () => {
  it("keeps both rates and a count per call", () => {
    const t = new PiTranscript().user("go");
    for (const model of [P, "other", P]) t.assistant([{ type: "toolCall", id: `c-${model}`, name: P, arguments: {} }], { input: 1000, output: 10, cacheRead: 1000, cacheWrite: 0, totalTokens: 2010, cost: piCost }, { model });
    const { session } = prepare(t.toJsonl(), "pi", "full");
    expect(Object.keys(session.stats.rates!).sort()).toEqual([P, "other"]);
    expect(session.stats.tools).toEqual({ [P]: 3 });
  });
});

describe("a tool named __proto__ in a Claude Code transcript, run by a subagent too", () => {
  const LAUNCH = "toolu_launch_1";
  const usage = { ...ccUsage(5, 7, 100, 50), cache_creation: { ephemeral_5m_input_tokens: 50, ephemeral_1h_input_tokens: 0 } };
  const main = () =>
    new ClaudeTranscript()
      .user("go")
      .assistant("m1", [{ type: "tool_use", id: "t1", name: P, input: { file_path: "/home/tester/work/demo/a.ts" } }], usage, "claude-sonnet-5-5")
      .toolResult("t1", "ok")
      .assistant("m2", [{ type: "tool_use", id: LAUNCH, name: "Agent", input: { subagent_type: "general-purpose", description: "Explore", prompt: "p" } }], usage, "claude-sonnet-5-5")
      .toolResult(LAUNCH, [{ type: "text", text: "done" }], { toolUseResult: { status: "completed", agentId: "a1", totalTokens: 9, totalToolUseCount: 1, totalDurationMs: 1, usage: { input_tokens: 1, output_tokens: 1 } } });
  const call = (id: string, model: string) => ({
    type: "assistant",
    isSidechain: true,
    uuid: `sc-${id}`,
    timestamp: "2026-01-01T00:00:00.500Z",
    message: { id, model, role: "assistant", content: [{ type: "text", text: "done" }], usage },
  });
  const file = (model: string): SubagentFileInput => ({
    fileName: "agent-a1.jsonl",
    raw: `${JSON.stringify(call("msg_a1", model))}\n`,
    meta: { toolUseId: LAUNCH },
  });

  it.each(SHARE_MODES)("keeps the tool in stats.tools (%s)", (mode) => {
    const { session, json, report } = prepare(main().toJsonl(), "claude-code", mode);
    expect(session.stats.tools[P]).toBe(1);
    expect(Object.hasOwn(parsed(json).stats.tools, P)).toBe(true);
    expect(report.stats.tools[P]).toBe(1);
  });

  it.each(SHARE_MODES)("keeps the model in subagentUsage.byModel, in the payload and the report (%s)", (mode) => {
    const { session, json, report } = prepare(main().toJsonl(), "claude-code", mode, [file(P)]);
    const byModel = session.stats.subagentUsage?.byModel;
    expect(has(byModel)).toBe(true);
    expect(Object.hasOwn(byModel!, P) && byModel![P]?.responses).toBe(1);
    expect(has((JSON.parse(json) as typeof session).stats.subagentUsage?.byModel)).toBe(true);
    expect(has(report.stats.subagentUsage?.byModel)).toBe(true);
  });
});

describe("an entry type named __proto__ is counted among the dropped entries", () => {
  it("keeps the count in the payload and the report", () => {
    const t = new PiTranscript().user("go");
    t.entry(P, {});
    const { session, report } = prepare(t.toJsonl(), "pi", "full");
    expect(Object.entries(session.redaction!.dropped)).toEqual([[P, 1]]);
    expect(Object.entries(report.dropped)).toEqual([[P, 1]]);
  });
});

describe("a tool input with a __proto__ key", () => {
  it("is published with the key", () => {
    const t = new ClaudeTranscript().user("go").assistant("m1", [{ type: "tool_use", id: "t1", name: "Custom", input: JSON.parse(`{"${P}": {"a": 1}, "b": 2}`) }], ccUsage(1, 1), "claude-sonnet-5-5").toolResult("t1", "ok");
    const { json } = prepare(t.toJsonl(), "claude-code", "full");
    expect(json).toContain(`"${P}":{"a":1}`);
  });
});

describe("the browse list summary", () => {
  it("counts a tool named __proto__", () => {
    const s = summarizeRaw({ harness: "pi", id: "pi-1", path: "/p.jsonl", mtimeMs: 1, size: 1 }, piSession("m", P));
    expect(Object.entries(s.tools)).toEqual([[P, 1]]);
  });
});

describe("safeKeys", () => {
  it("keeps a __proto__ key, and the entry renamed beside it", () => {
    const record = JSON.parse(`{"${P}": 1, "ghp_not_ok!": 2, "fine": 3}`) as Record<string, number>;
    const out = safeKeys(record, "model");
    expect(Object.entries(out)).toEqual([[P, 1], ["model-1", 2], ["fine", 3]]);
  });
});

describe("Redactor.redactIdentifierKeys (the pattern the others follow)", () => {
  it("keeps a __proto__ key", () => {
    const out = new Redactor({ ...machine }).redactIdentifierKeys(JSON.parse(`{"${P}": 1}`) as Record<string, number>, "stats");
    expect(Object.entries(out)).toEqual([[P, 1]]);
  });
});
