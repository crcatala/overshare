import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseClaudeCode } from "../src/adapters/claude-code.js";
import { type SubagentFileInput } from "../src/adapters/shared.js";
import { SUBAGENT_RESULT_CHARS, capToolText } from "../src/modes.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { prepareShare } from "../src/pipeline.js";
import { estimateCost } from "../src/pricing.js";
import { formatReport } from "../src/report.js";
import { SHARE_MODES, totalTokens, type NormalizedSession, type ShareMode, type SubagentStep } from "../src/schema.js";
import { computeStats } from "../src/stats.js";
import { loadSubagentFiles } from "../src/subagent-files.js";
import { ClaudeTranscript, ccUsage, fake } from "./helpers.js";
import { SUBAGENT_FIXTURES_DIR, costStateTotals, fixtureSessionIds, loadSubagentFixture, transcriptTotals, type TokenTotals } from "./subagent-fixtures.js";

const HAIKU = "claude-haiku-4-5-20251001";
const SONNET = "claude-sonnet-5-5";
const machine = { homeDir: "/home/fixture-user", username: "fixture-user" };

// ---- fixtures -------------------------------------------------------------------------------------------------

const fixturePath = (id: string) => join(SUBAGENT_FIXTURES_DIR, `${id}.jsonl`);
const idOf = (prefix: string) => fixtureSessionIds().find((id) => id.startsWith(prefix))!;

function parseFixture(prefix: string, withFiles = true) {
  const path = fixturePath(idOf(prefix));
  const result = parseClaudeCode(readFileSync(path, "utf8"), withFiles ? { subagentFiles: loadSubagentFiles(path) } : {});
  result.session.stats = computeStats(result.session);
  return result;
}

const subagentSteps = (s: NormalizedSession): SubagentStep[] => s.turns.flatMap((t) => t.steps).filter((x): x is SubagentStep => x.kind === "subagent");

/** Everything the session accounts for, per model: the main calls plus the subagent and unlinked buckets. */
function accountedTotals(s: NormalizedSession): Record<string, TokenTotals> {
  const out: Record<string, TokenTotals> = {};
  const add = (model: string, t: { input: number; output: number; cacheRead: number; cacheWrite: number }) => {
    const o = (out[model] ??= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    for (const k of ["input", "output", "cacheRead", "cacheWrite"] as const) o[k] += t[k];
  };
  for (const r of s.responses) add(r.model!, r.usage);
  const sub = s.stats.subagentUsage;
  for (const bucket of [sub, sub?.unlinked]) for (const [model, t] of Object.entries(bucket?.byModel ?? {})) add(model, t.tokens);
  return out;
}

// ---- inline builders ------------------------------------------------------------------------------------------

let lineSeq = 0;
/** Inside the session by default (the builder's main transcript runs from 00:00:01); `at` places a call elsewhere. */
const call = (id: string, blocks: Record<string, unknown>[], usage: Record<string, unknown>, model = HAIKU, at?: string) => {
  lineSeq += 1;
  return { type: "assistant", isSidechain: true, uuid: `sc-${lineSeq}`, timestamp: at ?? new Date(Date.UTC(2026, 0, 1, 0, 0, 0, lineSeq)).toISOString(), message: { id, model, role: "assistant", content: blocks, usage } };
};
const LATER = "2026-01-02T00:00:00.000Z";
const text = (t: string) => ({ type: "text", text: t });
const toolUse = (id: string) => ({ type: "tool_use", id, name: "Read", input: {} });
/** Usage with the cache write split the way subagents report it (5m) or the main session does (1h). */
const usage = (input: number, output: number, cacheRead: number, write: number, ttl: "5m" | "1h" = "5m") => ({
  ...ccUsage(input, output, cacheRead, write),
  cache_creation: { ephemeral_5m_input_tokens: ttl === "5m" ? write : 0, ephemeral_1h_input_tokens: ttl === "1h" ? write : 0 },
});
const agentFile = (agentId: string, lines: object[], meta?: Record<string, unknown>): SubagentFileInput => ({
  fileName: `agent-${agentId}.jsonl`,
  raw: `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`,
  ...(meta ? { meta } : {}),
});

const LAUNCH = "toolu_launch_1";
const launchInput = { subagent_type: "general-purpose", description: "Explore the code", prompt: "prompt" };

/** A main transcript with one Agent launch; `result` shapes the tool_result like Claude Code's foreground and background modes. */
function mainWithLaunch(result: { kind: "completed"; text: string } | { kind: "async" } | { kind: "none" }, o: { input?: Record<string, unknown>; agentId?: string } = {}): ClaudeTranscript {
  const t = new ClaudeTranscript()
    .user("go")
    .assistant("m1", [{ type: "tool_use", id: LAUNCH, name: "Agent", input: o.input ?? launchInput }], usage(10, 5, 0, 100, "1h"), SONNET);
  if (result.kind === "completed") {
    t.toolResult(LAUNCH, [{ type: "text", text: result.text }], {
      toolUseResult: { status: "completed", agentId: o.agentId ?? "a1", totalTokens: 999, totalToolUseCount: 3, totalDurationMs: 4000, usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 } },
    });
  } else if (result.kind === "async") {
    t.toolResult(LAUNCH, [{ type: "text", text: "Async agent launched successfully." }], { toolUseResult: { status: "async_launched", agentId: o.agentId ?? "a1", outputFile: "/tmp/x.output" } });
  }
  return t;
}

const notificationLine = (t: ClaudeTranscript, toolUseId: string, result: string) =>
  t.user(`<task-notification>\n<task-id>a1</task-id>\n<tool-use-id>${toolUseId}</tool-use-id>\n<status>completed</status>\n<result>${result}</result>\n<usage><subagent_tokens>1</subagent_tokens></usage>\n</task-notification>`, {
    origin: { kind: "task-notification", producer: "session-task" },
  });

function parse(t: ClaudeTranscript, files: SubagentFileInput[] | undefined, leafId?: string) {
  const r = parseClaudeCode(t.toJsonl(), { subagentFiles: files, leafId });
  r.session.stats = computeStats(r.session);
  return r;
}

const oneCallFile = (agentId: string, meta: Record<string, unknown> | undefined, finalText = "done") =>
  agentFile(agentId, [call(`msg_${agentId}`, [text(finalText)], usage(5, 7, 100, 50))], meta);

// ---------------------------------------------------------------------------------------------------------------

describe("cost-state cross-check through the adapter", () => {
  const ids = fixtureSessionIds();

  for (const id of ids) {
    it(`${id.slice(0, 8)}: main + subagent + unlinked usage equals the raw files' total, per model`, () => {
      const { session } = parseFixture(id);
      expect(accountedTotals(session)).toEqual(transcriptTotals(loadSubagentFixture(id)));
    });
  }

  it("equals Claude Code's cost-state on all four token fields in every reconciled session", () => {
    for (const id of ids.filter((i) => !i.startsWith("9150e1c1"))) {
      const { session } = parseFixture(id);
      expect(accountedTotals(session), id).toEqual(costStateTotals(loadSubagentFixture(id)));
    }
  });

  it("never folds subagent usage into the main totals", () => {
    for (const id of ids) {
      const { session } = parseFixture(id);
      const mainOnly = transcriptTotals({ ...loadSubagentFixture(id), subagents: [] });
      const mainOutput = Object.values(mainOnly).reduce((n, t) => n + t.output, 0);
      expect(session.stats.tokens.output, id).toBe(mainOutput);
      expect(session.stats.responses, id).toBe(session.responses.length);
    }
  });

  it("leaves the main totals as they are when the subagent files are read", () => {
    const without = parseFixture("2b450029", false).session;
    expect(without.stats.subagentUsage).toBeUndefined();
    expect(parseFixture("2b450029").session.stats.tokens).toEqual(without.stats.tokens);
  });
});

describe("what a subagent file adds to its launching step", () => {
  it("sums every model call, deduplicating the lines a response is split over", () => {
    const file = agentFile(
      "a1",
      [
        call("msg_a", [{ type: "thinking", thinking: "t" }], usage(10, 4, 0, 1000)), // streamed partial
        call("msg_a", [toolUse("tu_1")], usage(10, 135, 0, 1000)),
        call("msg_b", [text("final answer")], usage(12, 50, 1000, 200)),
      ],
      { toolUseId: LAUNCH },
    );
    const { session } = parse(mainWithLaunch({ kind: "async" }), [file]);
    const [step] = subagentSteps(session);
    expect(step!.usage).toMatchObject({ input: 22, output: 185, cacheRead: 1000, cacheWrite: 1200, turns: 2, toolUses: 1, totalTokens: 22 + 185 + 1000 + 1200, models: [HAIKU] });
    expect(session.stats.subagentUsage).toMatchObject({ agents: 1, responses: 2, tokens: { input: 22, output: 185, cacheRead: 1000, cacheWrite: 1200 } });
    expect(session.stats.subagentUsage!.unlinked).toBeUndefined();
  });

  it("replaces the tool result's last-call figures with the file total, keeping the launch's own duration", () => {
    const file = agentFile("a1", [call("msg_1", [toolUse("t")], usage(1, 10, 0, 100)), call("msg_2", [text("ok")], usage(2, 20, 100, 10))], { toolUseId: LAUNCH });
    const [step] = subagentSteps(parse(mainWithLaunch({ kind: "completed", text: "ok" }), [file]).session);
    expect(step!.usage).toMatchObject({ input: 3, output: 30, totalTokens: 3 + 30 + 100 + 110, turns: 2, toolUses: 1, durationMs: 4000 });
    expect(step!.usage!.totalTokens).not.toBe(999);
  });

  it("prices each call at its model's rate and keeps models apart", () => {
    const file = agentFile(
      "a1",
      [call("msg_h", [toolUse("t")], usage(100, 200, 5_000, 1_000), HAIKU), call("msg_s", [text("ok")], usage(50, 80, 9_000, 2_000), SONNET)],
      { toolUseId: LAUNCH },
    );
    const { session } = parse(mainWithLaunch({ kind: "async" }), [file]);
    const sub = session.stats.subagentUsage!;
    expect(Object.keys(sub.byModel).sort()).toEqual([HAIKU, SONNET]);
    const haiku = estimateCost(HAIKU, { input: 100, output: 200, cacheRead: 5_000, cacheWrite: 1_000, reasoning: 0 })!;
    const sonnet = estimateCost(SONNET, { input: 50, output: 80, cacheRead: 9_000, cacheWrite: 2_000, reasoning: 0 })!;
    expect(sub.byModel[HAIKU]!.cost).toBeCloseTo(haiku, 10);
    expect(sub.byModel[SONNET]!.cost).toBeCloseTo(sonnet, 10);
    expect(sub.cost).toBeCloseTo(haiku + sonnet, 10);
    expect(subagentSteps(session)[0]!.usage).toMatchObject({ models: [HAIKU, SONNET] });
    expect(subagentSteps(session)[0]!.usage!.cost).toBeCloseTo(haiku + sonnet, 10);
  });

  it("prices 5-minute and 1-hour cache writes per call, whatever the main session wrote", () => {
    const five = agentFile("a5", [call("msg_5", [text("x")], usage(10, 10, 0, 10_000, "5m"))], { toolUseId: "t5" });
    const hour = agentFile("a1h", [call("msg_1h", [text("x")], usage(10, 10, 0, 10_000, "1h"))], { toolUseId: "t1h" });
    const t = new ClaudeTranscript()
      .user("go")
      .assistant("m1", [{ type: "tool_use", id: "t5", name: "Agent", input: launchInput }, { type: "tool_use", id: "t1h", name: "Agent", input: launchInput }], usage(10, 5, 0, 100, "1h"), SONNET);
    const [s5, s1h] = subagentSteps(parse(t, [five, hour]).session);
    const base = { input: 10, output: 10, cacheRead: 0, cacheWrite: 10_000, reasoning: 0 };
    expect(s5!.usage!.cacheWrite1h).toBeUndefined();
    expect(s1h!.usage!.cacheWrite1h).toBe(10_000);
    expect(s5!.usage!.cost).toBeCloseTo(estimateCost(HAIKU, base)!, 10);
    expect(s1h!.usage!.cost).toBeCloseTo(estimateCost(HAIKU, { ...base, cacheWrite1h: 10_000 })!, 10);
    expect(s1h!.usage!.cost!).toBeGreaterThan(s5!.usage!.cost!);
  });

  it("leaves the cost out, and flags the total, when a model has no price", () => {
    const file = agentFile("a1", [call("msg_1", [text("ok")], usage(1, 2, 3, 4), "claude-made-up-9")], { toolUseId: LAUNCH });
    const { session } = parse(mainWithLaunch({ kind: "async" }), [file]);
    expect(subagentSteps(session)[0]!.usage!.cost).toBeUndefined();
    expect(session.stats.subagentUsage!.cost).toBeUndefined();
    const priced = agentFile("a2", [call("msg_2", [text("ok")], usage(1, 2, 3, 4)), call("msg_3", [text("ok")], usage(1, 2, 3, 4), "claude-made-up-9")], { toolUseId: LAUNCH });
    const mixed = parse(mainWithLaunch({ kind: "async" }), [priced]).session;
    expect(mixed.stats.subagentUsage!.costPartial).toBe(true);
    expect(subagentSteps(mixed)[0]!.usage!.cost).toBeUndefined();
  });
});

describe("deduplication", () => {
  it("counts a call once when main and a subagent file both hold it, preferring the main copy", () => {
    const t = mainWithLaunch({ kind: "async" });
    const mainId = "m1"; // the launching assistant message in the main transcript
    const file = agentFile(
      "a1",
      [call(mainId, [text("replayed parent message")], usage(9_999, 9_999, 9_999, 9_999), SONNET), call("msg_own", [text("ok")], usage(1, 2, 3, 4))],
      { toolUseId: LAUNCH },
    );
    const { session } = parse(t, [file]);
    expect(session.stats.subagentUsage).toMatchObject({ responses: 1, tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 } });
    expect(session.stats.tokens).toMatchObject({ input: 10, output: 5 });
  });

  it("counts a call once when two subagent files hold it, keeping the earlier file", () => {
    const dup = (n: number) => call("msg_shared", [text("x")], usage(n, n, 0, 0));
    const a = agentFile("a-first", [dup(10), call("msg_a", [text("a")], usage(1, 1, 0, 0))], { toolUseId: LAUNCH });
    const b = agentFile("b-second", [dup(500), call("msg_b", [text("b")], usage(2, 2, 0, 0))], { toolUseId: "toolu_other" });
    const { session } = parse(mainWithLaunch({ kind: "async" }), [b, a]);
    expect(session.stats.subagentUsage!.tokens.input + (session.stats.subagentUsage!.unlinked?.tokens.input ?? 0)).toBe(10 + 1 + 2);
  });

  it("does not count a resumed subagent twice: its file only grows", () => {
    const first = [call("msg_1", [toolUse("t")], usage(1, 10, 0, 100)), call("msg_2", [text("first report")], usage(2, 20, 100, 10))];
    const resumed = [...first, call("msg_3", [toolUse("t2")], usage(3, 30, 110, 5)), call("msg_4", [text("second report")], usage(4, 40, 115, 5))];
    const once = parse(mainWithLaunch({ kind: "async" }), [agentFile("a1", first, { toolUseId: LAUNCH })]).session;
    const twice = parse(mainWithLaunch({ kind: "async" }), [agentFile("a1", [...resumed, ...first], { toolUseId: LAUNCH })]).session;
    expect(once.stats.subagentUsage!.responses).toBe(2);
    expect(twice.stats.subagentUsage).toMatchObject({ agents: 1, responses: 4, tokens: { input: 10, output: 100 } });
    expect(subagentSteps(twice)[0]!.usage).toMatchObject({ turns: 4, toolUses: 2 });
  });
});

describe("launch shapes, on the fixtures", () => {
  it("background (2b450029): async steps carry the file total and the notification's answer", () => {
    const { session, dropped } = parseFixture("2b450029");
    const steps = subagentSteps(session);
    expect(steps).toHaveLength(2);
    const notifications = readFileSync(fixturePath(idOf("2b450029")), "utf8")
      .split("\n")
      .filter((l) => l.includes("task-notification") && l.includes('"origin"'))
      .map((l) => /<result>([\s\S]*?)<\/result>/.exec(JSON.parse(l).message.content)![1]!.trim());
    for (const step of steps) {
      expect(step.async).toBe(true);
      expect(step.usage).toMatchObject({ turns: 2 });
      expect(notifications).toContain(step.result!.text);
    }
    expect(session.stats.subagentUsage).toMatchObject({ agents: 2, responses: 4 });
    expect(dropped["subagent-transcript"]).toBe(2);
  });

  it("foreground (491c3f9b): the tool result stays the answer, the usage is the total, not the last call", () => {
    const f = loadSubagentFixture(idOf("491c3f9b"));
    const lastCall = f.main.find((l) => l.toolUseResult?.status === "completed")!.toolUseResult;
    const [step] = subagentSteps(parseFixture("491c3f9b").session);
    expect(step!.result!.text).toContain("[Subagent hand-back]");
    expect(step!.usage!.totalTokens).toBeGreaterThan(lastCall.totalTokens);
    expect(step!.usage!.totalTokens).toBe(totalTokens(parseFixture("491c3f9b").session.stats.subagentUsage!.tokens));
    expect(step!.usage).toMatchObject({ output: 537, toolUses: lastCall.totalToolUseCount, durationMs: lastCall.totalDurationMs });
  });

  it("parallel (bf3c7500): each launch gets its own file, and steps add up to the session figure", () => {
    const { session } = parseFixture("bf3c7500");
    const steps = subagentSteps(session);
    expect(steps).toHaveLength(3);
    expect(steps.reduce((n, s) => n + s.usage!.totalTokens!, 0)).toBe(totalTokens(session.stats.subagentUsage!.tokens));
    // Claude Code chains parallel results as siblings, so the exported branch keeps only one of them;
    // the others get the subagent's own final message instead of an empty step.
    for (const s of steps) expect(s.result?.text.length, s.id).toBeGreaterThan(0);
  });

  it("mixed models (9a69feab): the Haiku reviewer is priced as Haiku beside the Sonnet main", () => {
    const { session } = parseFixture("9a69feab");
    const sub = session.stats.subagentUsage!;
    expect(Object.keys(sub.byModel)).toEqual([HAIKU]);
    expect(session.responses.every((r) => r.model === SONNET)).toBe(true);
    expect(sub.cost).toBeCloseTo(estimateCost(HAIKU, { ...sub.tokens, reasoning: 0 })!, 10);
    expect(subagentSteps(session)[0]!.usage).toMatchObject({ turns: 9, toolUses: 18 });
  });

  it("5m and 1h (every session): subagent cache writes are priced at the 5m rate they were written at", () => {
    for (const id of fixtureSessionIds()) {
      const { session } = parseFixture(id);
      const sub = session.stats.subagentUsage!;
      for (const bucket of [sub, sub.unlinked]) {
        if (!bucket || bucket.responses === 0) continue;
        expect(bucket.tokens.cacheWrite1h, id).toBeUndefined();
        const at5m = Object.entries(bucket.byModel).reduce((n, [model, m]) => n + estimateCost(model, { ...m.tokens, reasoning: 0 })!, 0);
        expect(bucket.cost, id).toBeCloseTo(at5m, 10);
      }
      // The same session's main calls wrote 1h entries, so pricing the two alike would be visibly wrong.
      for (const r of session.responses) if (r.usage.cacheWrite > 0) expect(r.usage.cacheWrite1h, id).toBe(r.usage.cacheWrite);
    }
  });

  it("resumed (113ee2dc): the file keeps growing after SendMessage, and the step total covers all of it", () => {
    const f = loadSubagentFixture(idOf("113ee2dc"));
    const launchResult = f.main.find((l) => l.toolUseResult?.status === "completed")!.toolUseResult;
    const { session } = parseFixture("113ee2dc");
    const [step] = subagentSteps(session);
    expect(f.subagents).toHaveLength(1);
    expect(step!.usage).toMatchObject({ turns: 4 });
    expect(step!.usage!.totalTokens).toBeGreaterThan(launchResult.totalTokens);
    expect(accountedTotals(session)).toEqual(costStateTotals(f));
  });

  it("nested (1c1bb33a): the grandchild is rolled into the step that launched its parent, once", () => {
    const { session } = parseFixture("1c1bb33a");
    const steps = subagentSteps(session);
    expect(steps).toHaveLength(1);
    expect(steps[0]!.usage).toMatchObject({ nested: 1, turns: 4 });
    expect(session.stats.subagentUsage).toMatchObject({ agents: 2, responses: 4 });
    expect(session.stats.subagentUsage!.unlinked).toBeUndefined();
    expect(steps[0]!.usage!.totalTokens).toBe(totalTokens(session.stats.subagentUsage!.tokens));
  });
});

describe("the launching step's summary", () => {
  it("uses the subagent's final message for a background launch that has no notification", () => {
    const { session } = parse(mainWithLaunch({ kind: "async" }), [oneCallFile("a1", { toolUseId: LAUNCH }, "FINAL-from-file")]);
    const [step] = subagentSteps(session);
    expect(step!.async).toBe(true);
    expect(step!.result!.text).toBe("FINAL-from-file");
  });

  it("prefers the notification's answer to the file's, and a foreground result to both", () => {
    const async = mainWithLaunch({ kind: "async" });
    notificationLine(async, LAUNCH, "ANSWER-from-notification");
    expect(subagentSteps(parse(async, [oneCallFile("a1", { toolUseId: LAUNCH }, "FINAL-from-file")]).session)[0]!.result!.text).toBe("ANSWER-from-notification");
    const fg = mainWithLaunch({ kind: "completed", text: "ANSWER-from-tool-result" });
    expect(subagentSteps(parse(fg, [oneCallFile("a1", { toolUseId: LAUNCH }, "FINAL-from-file")]).session)[0]!.result!.text).toBe("ANSWER-from-tool-result");
  });

  it("keeps the launch acknowledgement when the agent ended mid-tool and has no final message", () => {
    const file = agentFile("a1", [call("msg_1", [text("Let me look."), toolUse("t")], usage(1, 2, 3, 4))], { toolUseId: LAUNCH });
    const [step] = subagentSteps(parse(mainWithLaunch({ kind: "async" }), [file]).session);
    expect(step!.result!.text).toBe("Async agent launched successfully.");
    expect(step!.usage!.turns).toBe(1);
  });

  it("keeps the summary whole; the share pipeline bounds it like a notification answer after redaction, and says what it cut (ass-yyg0)", () => {
    const long = "x".repeat(SUBAGENT_RESULT_CHARS + 500);
    const parsed = parse(mainWithLaunch({ kind: "async" }), [oneCallFile("a1", { toolUseId: LAUNCH }, long)]).session;
    expect(subagentSteps(parsed)[0]!.result).toEqual({ text: long });
    const [step] = subagentSteps(capToolText(parsed));
    expect(step!.result!.truncatedFrom).toBe(long.length);
    expect(step!.result!.text.startsWith("x".repeat(SUBAGENT_RESULT_CHARS))).toBe(true);
    expect(step!.result!.text.length).toBeLessThan(long.length);
  });

  it("strips injected context from the summary like any other text", () => {
    const [step] = subagentSteps(parse(mainWithLaunch({ kind: "async" }), [oneCallFile("a1", { toolUseId: LAUNCH }, "report<system-reminder>harness text</system-reminder>")]).session);
    expect(step!.result!.text).toBe("report");
  });
});

describe("linking a subagent to its launch", () => {
  it("keeps subagents that no step launched apart from every other figure", () => {
    const { session, dropped } = parse(mainWithLaunch({ kind: "async" }), [oneCallFile("stranger", { toolUseId: "toolu_nowhere" })]);
    const sub = session.stats.subagentUsage!;
    expect(sub).toMatchObject({ agents: 0, responses: 0 });
    expect(sub.unlinked).toMatchObject({ agents: 1, responses: 1, tokens: { input: 5, output: 7 } });
    expect(session.stats.tokens).toMatchObject({ input: 10, output: 5 });
    expect(subagentSteps(session)[0]!.usage).toBeUndefined();
    expect(dropped["subagent-transcript"]).toBe(1);
  });

  it("puts a forked skill, which has no launching call, in that bucket (1ccce9c5)", () => {
    const { session } = parseFixture("1ccce9c5");
    expect(session.stats.responses).toBe(0);
    expect(session.stats.subagentUsage).toMatchObject({ agents: 0, unlinked: { agents: 1 } });
    expect(session.stats.subagentUsage!.unlinked!.tokens.output).toBe(464);
  });

  it("links by the agent id in the tool result when the meta file is missing or has no tool id", () => {
    const noMeta = parse(mainWithLaunch({ kind: "async" }, { agentId: "a1" }), [oneCallFile("a1", undefined)]).session;
    expect(subagentSteps(noMeta)[0]!.usage).toMatchObject({ turns: 1 });
    const wrongType = parse(mainWithLaunch({ kind: "async" }, { agentId: "a1" }), [oneCallFile("a1", { toolUseId: 42, unknownField: { a: 1 } })]).session;
    expect(subagentSteps(wrongType)[0]!.usage).toMatchObject({ turns: 1 });
    expect(noMeta.stats.subagentUsage!.unlinked).toBeUndefined();
  });

  it("follows parentAgentId through nested agents, and survives a cycle", () => {
    const files = [
      oneCallFile("root", { toolUseId: LAUNCH }),
      oneCallFile("child", { toolUseId: "toolu_in_parent", parentAgentId: "root", spawnDepth: 2 }),
      oneCallFile("grandchild", { toolUseId: "toolu_in_child", parentAgentId: "child", spawnDepth: 3 }),
      oneCallFile("loop-a", { toolUseId: "x1", parentAgentId: "loop-b" }),
      oneCallFile("loop-b", { toolUseId: "x2", parentAgentId: "loop-a" }),
    ];
    const { session } = parse(mainWithLaunch({ kind: "async" }), files);
    expect(subagentSteps(session)[0]!.usage).toMatchObject({ nested: 2, turns: 3 });
    expect(session.stats.subagentUsage).toMatchObject({ agents: 3 });
    expect(session.stats.subagentUsage!.unlinked).toMatchObject({ agents: 2 });
  });

  it("treats the launch of a branch that is not exported as unlinked", () => {
    const t = new ClaudeTranscript().user("go");
    const base = t.lastUuid;
    t.assistant("m_old", [{ type: "tool_use", id: "toolu_old", name: "Agent", input: launchInput }], usage(1, 1, 0, 0), SONNET);
    t.rewindTo(base).assistant("m_new", [text("took another way")], usage(1, 1, 0, 0), SONNET);
    const { session } = parse(t, [oneCallFile("a1", { toolUseId: "toolu_old" })]);
    expect(subagentSteps(session)).toHaveLength(0);
    expect(session.stats.subagentUsage).toMatchObject({ agents: 0, unlinked: { agents: 1 } });
  });
});

describe("a cut export does not publish what came after it", () => {
  const LATE = "LATE-final-answer-written-after-the-exported-point";
  const ACK = "Async agent launched successfully.";

  /** An async launch, its notification and a later prompt; the agent's file ends with a message written after all of that. */
  function session() {
    const t = mainWithLaunch({ kind: "async" });
    const afterLaunch = t.lastUuid!;
    notificationLine(t, LAUNCH, "ANSWER-from-notification");
    const afterNotification = t.lastUuid!;
    t.user("a later prompt");
    const file = agentFile(
      "a1",
      [call("c_early", [toolUse("t")], usage(5, 5, 0, 0)), call("c_late", [text(LATE)], usage(500, 500, 0, 0), HAIKU, LATER)],
      { toolUseId: LAUNCH },
    );
    return { t, file, afterLaunch, afterNotification };
  }
  const exportOf = (mode: ShareMode, o: ReturnType<typeof session>, leafId?: string) =>
    prepareShare(o.t.toJsonl(), { mode, config: DEFAULT_CONFIG, harness: "claude-code", machine, knownSecrets: [], subagentFiles: [o.file], leafId });

  it("leaves out the agent's later answer and later calls when the export ends at the launch", () => {
    const o = session();
    const { session: s } = parse(o.t, [o.file], o.afterLaunch);
    const [step] = subagentSteps(s);
    expect(step!.result!.text).toBe(ACK);
    expect(step!.usage).toMatchObject({ turns: 1, output: 5 });
    expect(s.stats.subagentUsage).toMatchObject({ responses: 1, tokens: { output: 5 } });
    for (const mode of SHARE_MODES) expect(exportOf(mode, o, o.afterLaunch).json, mode).not.toContain(LATE);
  });

  it("keeps the notification's answer when the export ends after it, and still ignores the file's later message", () => {
    const o = session();
    const [step] = subagentSteps(parse(o.t, [o.file], o.afterNotification).session);
    expect(step!.result!.text).toBe("ANSWER-from-notification");
    expect(step!.usage).toMatchObject({ turns: 1 });
  });

  it("does not summarise from a message written after the session's end, even on a plain export", () => {
    const o = session();
    const { session: s } = parse(o.t, [o.file]);
    expect(subagentSteps(s)[0]!.result!.text).toBe("ANSWER-from-notification");
    const noNotice = mainWithLaunch({ kind: "async" });
    const [step] = subagentSteps(parse(noNotice, [agentFile("a1", [call("c", [text(LATE)], usage(1, 1, 0, 0), HAIKU, LATER)], { toolUseId: LAUNCH })]).session);
    expect(step!.result!.text).toBe(ACK);
    expect(step!.usage).toMatchObject({ turns: 1 }); // the numbers are still counted: the agent really ran
  });

  it("offers no file summary when the branch was cut by a rewind, so a resume on the discarded branch stays private", () => {
    const t = mainWithLaunch({ kind: "async" });
    const afterLaunch = t.lastUuid!;
    t.user("resume the agent").assistant("m_resume", [{ type: "tool_use", id: "S", name: "SendMessage", input: { to: "a1", message: "go on" } }], usage(3, 3, 0, 0), SONNET);
    t.rewindTo(afterLaunch).assistant("m_kept", [text("took another way")], usage(2, 2, 0, 0), SONNET);
    const file = agentFile("a1", [call("c1", [toolUse("t")], usage(5, 5, 0, 0)), call("c2", [text("RESUMED-answer-from-the-discarded-branch")], usage(6, 6, 0, 0))], { toolUseId: LAUNCH });
    const { session: s } = parse(t, [file]);
    expect(s.stats.otherBranches).toBeDefined();
    expect(subagentSteps(s)[0]!.result!.text).toBe(ACK);
    for (const mode of SHARE_MODES) {
      const { json } = prepareShare(t.toJsonl(), { mode, config: DEFAULT_CONFIG, harness: "claude-code", machine, knownSecrets: [], subagentFiles: [file] });
      expect(json, mode).not.toContain("RESUMED-answer");
    }
  });
});

describe("linking through the task notification", () => {
  const launchOnly = () =>
    new ClaudeTranscript().user("go").assistant("m1", [{ type: "tool_use", id: LAUNCH, name: "Agent", input: launchInput }], usage(10, 5, 0, 100, "1h"), SONNET);
  const noMeta = () => agentFile("a1", [call("c1", [text("file answer")], usage(5, 7, 100, 50))]);

  it("links a file with no tool id in its meta through the notification, when the launch's tool result is not on the branch", () => {
    const t = launchOnly();
    notificationLine(t, LAUNCH, "ANSWER-from-notification");
    const { session: s } = parse(t, [noMeta()]);
    const [step] = subagentSteps(s);
    expect(step!.result!.text).toBe("ANSWER-from-notification");
    expect(step!.usage).toMatchObject({ turns: 1, output: 7 });
    expect(s.stats.subagentUsage).toMatchObject({ agents: 1 });
    expect(s.stats.subagentUsage!.unlinked).toBeUndefined();
  });

  it("matches a notification that names only the agent, when the launch's tool result gave that agent id", () => {
    const t = mainWithLaunch({ kind: "async" }, { agentId: "a1" });
    t.user("<task-notification>\n<task-id>a1</task-id>\n<result>ANSWER-by-agent-id</result>\n</task-notification>", { origin: { kind: "task-notification" } });
    const { session: s, dropped } = parse(t, undefined);
    expect(subagentSteps(s)[0]!.result!.text).toBe("ANSWER-by-agent-id");
    expect(dropped["task-notification"]).toBe(1);
  });

  it("still drops a notification that names no known launch", () => {
    const t = launchOnly();
    t.user("<task-notification>\n<task-id>stranger</task-id>\n<tool-use-id>toolu_nowhere</tool-use-id>\n<result>UNMATCHED-answer</result>\n</task-notification>", { origin: { kind: "task-notification" } });
    const { session: s, dropped } = parse(t, undefined);
    expect(JSON.stringify(s)).not.toContain("UNMATCHED-answer");
    expect(dropped["task-notification:unmatched"]).toBe(1);
  });
});

describe("files that are missing or damaged", () => {
  it("reads nothing without subagent files, and tool_result tokens are still not shown as a total", () => {
    const { session, dropped } = parse(mainWithLaunch({ kind: "completed", text: "ok" }), undefined);
    expect(session.stats.subagentUsage).toBeUndefined();
    expect(dropped["subagent-transcript"]).toBeUndefined();
    expect(subagentSteps(session)[0]!.usage).toEqual({ toolUses: 3, durationMs: 4000 });
    expect(parse(mainWithLaunch({ kind: "completed", text: "ok" }), []).session.stats.subagentUsage).toBeUndefined();
  });

  it("skips torn and junk lines, and counts a file with nothing usable as an agent with no calls", () => {
    const good = JSON.stringify(call("msg_1", [text("fine")], usage(1, 2, 3, 4)));
    const damaged: SubagentFileInput = { fileName: "agent-a1.jsonl", raw: `not json\n${good}\n[1,2]\n{"type":"assist`, meta: { toolUseId: LAUNCH } };
    const empty: SubagentFileInput = { fileName: "agent-a2.jsonl", raw: "", meta: { toolUseId: "toolu_other" } };
    const noUsage = agentFile("a3", [{ type: "assistant", message: { id: "m", model: HAIKU, content: [text("no usage")] } }, call("msg_s", [text("s")], usage(9, 9, 9, 9), "<synthetic>")], { toolUseId: "toolu_third" });
    const { session } = parse(mainWithLaunch({ kind: "async" }), [damaged, empty, noUsage]);
    expect(subagentSteps(session)[0]!.usage).toMatchObject({ turns: 1, output: 2 });
    expect(session.stats.subagentUsage).toMatchObject({ agents: 1, responses: 1 });
    expect(session.stats.subagentUsage!.unlinked).toMatchObject({ agents: 2, responses: 0 });
  });
});

describe("loadSubagentFiles", () => {
  it("reads the agent files and their meta files next to a session", () => {
    const files = loadSubagentFiles(fixturePath(idOf("2b450029")));
    expect(files.map((f) => f.fileName)).toEqual([...files.map((f) => f.fileName)].sort());
    expect(files).toHaveLength(2);
    expect(files.every((f) => f.fileName.startsWith("agent-") && f.fileName.endsWith(".jsonl") && f.raw.length > 0)).toBe(true);
    expect(files.every((f) => typeof f.meta?.toolUseId === "string")).toBe(true);
  });

  it("returns nothing for a session with no subagent directory", () => {
    expect(loadSubagentFiles(join(tmpdir(), "no-such-session-dir", "abc.jsonl"))).toEqual([]);
  });

  it("ignores other files in the directory and malformed meta files", () => {
    const root = mkdtempSync(join(tmpdir(), "as-sub-"));
    const dir = join(root, "sess", "subagents");
    mkdirSync(dir, { recursive: true });
    const line = `${JSON.stringify(call("msg_1", [text("x")], usage(1, 1, 1, 1)))}\n`;
    writeFileSync(join(dir, "agent-a1.jsonl"), line);
    writeFileSync(join(dir, "agent-a1.meta.json"), "{not json");
    writeFileSync(join(dir, "agent-a2.jsonl"), line);
    writeFileSync(join(dir, "agent-a2.meta.json"), JSON.stringify(["array"]));
    writeFileSync(join(dir, "agent-a2.forked-skill.json"), "{}");
    writeFileSync(join(dir, "agent-a2.forked-skill.marker.json"), "{}");
    writeFileSync(join(dir, "notes.jsonl"), line);
    writeFileSync(join(dir, "agent-a3.jsonl"), line);
    const files = loadSubagentFiles(join(root, "sess.jsonl"));
    expect(files.map((f) => f.fileName)).toEqual(["agent-a1.jsonl", "agent-a2.jsonl", "agent-a3.jsonl"]);
    expect(files.map((f) => f.meta)).toEqual([undefined, undefined, undefined]);
  });
});

describe("share modes", () => {
  const MARKER = "MARKER-final-answer-of-the-subagent";
  const DESC = "MARKER-description-of-the-task";
  const token = fake.github();
  const secretSession = () => {
    const t = mainWithLaunch({ kind: "async" }, { input: { ...launchInput, description: DESC } });
    const file = oneCallFile("a1", { toolUseId: LAUNCH }, `${MARKER} ${token}`);
    return { t, file };
  };
  const share = (mode: ShareMode, extra: { t: ClaudeTranscript; file: SubagentFileInput } = secretSession()) =>
    prepareShare(extra.t.toJsonl(), { mode, config: DEFAULT_CONFIG, harness: "claude-code", machine, knownSecrets: [], subagentFiles: [extra.file], now: new Date("2026-01-01") });

  it("full keeps the bounded summary, redacted like the main transcript", () => {
    const { session, json, report } = share("full");
    const step = subagentSteps(session)[0]!;
    expect(step.result!.text).toContain(MARKER);
    expect(step.usage).toMatchObject({ turns: 1 });
    expect(json).not.toContain(token);
    expect(step.result!.text).not.toContain(token);
    expect(report.counts.github_token ?? Object.values(report.counts).reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
    expect(report.dropped["subagent-transcript"]).toBe(1);
  });

  it("brief and minimal drop the summary but keep description, agent type and numbers", () => {
    for (const mode of ["brief", "minimal"] as const) {
      const { session, json } = share(mode);
      const step = subagentSteps(session)[0]!;
      expect(step.result, mode).toBeUndefined();
      expect(step).toMatchObject({ description: DESC, agents: ["general-purpose"], usage: { turns: 1 } });
      expect(json, mode).not.toContain(MARKER);
    }
  });

  it("prompts carries no subagent text and no steps, only the aggregate numbers", () => {
    const { session, json } = share("prompts");
    expect(session.turns.every((t) => t.steps.length === 0)).toBe(true);
    expect(json).not.toContain(MARKER);
    expect(json).not.toContain(DESC);
    expect(session.stats.subagentUsage).toMatchObject({ agents: 1, responses: 1 });
  });

  it("leaves every statistic, the subagent ones included, the same in every mode", () => {
    const stats = SHARE_MODES.map((m) => JSON.stringify(share(m).session.stats));
    expect(new Set(stats).size).toBe(1);
    expect(JSON.parse(stats[0]!).subagentUsage).toMatchObject({ agents: 1 });
    for (const id of fixtureSessionIds()) {
      const raw = readFileSync(fixturePath(id), "utf8");
      const files = loadSubagentFiles(fixturePath(id));
      const byMode = SHARE_MODES.map((mode) => prepareShare(raw, { mode, config: DEFAULT_CONFIG, harness: "claude-code", machine, knownSecrets: [], subagentFiles: files, now: new Date("2026-01-01") }).session.stats);
      for (const s of byMode) expect(s, id).toEqual(byMode[0]);
    }
  });

  it("keeps text out of the subagent statistics", () => {
    const sub = share("full").session.stats.subagentUsage;
    const json = JSON.stringify(sub);
    expect(json).not.toContain(MARKER);
    expect(json).not.toContain(DESC);
    expect(json).not.toContain("general-purpose");
    // Numbers, booleans and the model ids that key byModel: nothing else.
    const strings: string[] = [];
    (function walk(v: unknown, key = "") {
      if (typeof v === "string") strings.push(v);
      else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { if (k === HAIKU || k === "unlinked" || /^[a-z]/.test(k)) walk(x, k); }
    })(sub);
    expect(strings).toEqual([]);
  });

  it("publishes no subagent text in prompts mode for any fixture session", () => {
    for (const id of fixtureSessionIds()) {
      const raw = readFileSync(fixturePath(id), "utf8");
      const files = loadSubagentFiles(fixturePath(id));
      const opts = { config: DEFAULT_CONFIG, harness: "claude-code" as const, machine, knownSecrets: [], subagentFiles: files };
      const full = prepareShare(raw, { ...opts, mode: "full" }).session;
      const prompts = prepareShare(raw, { ...opts, mode: "prompts" }).json;
      for (const s of subagentSteps(full)) for (const probe of [s.result?.text.slice(0, 60), s.description]) if (probe) expect(prompts, `${id} ${probe}`).not.toContain(probe);
    }
  });

  it("reports the subagent usage and the transcripts it did not share", () => {
    const { report } = share("full");
    const text = formatReport(report);
    expect(text).toMatch(/not counted: .*1 call.* by 1 subagent/);
    expect(text).toMatch(/subagent-transcript ×1/);
    const forked = prepareShare(readFileSync(fixturePath(idOf("1ccce9c5")), "utf8"), { mode: "full", config: DEFAULT_CONFIG, harness: "claude-code", machine, knownSecrets: [], subagentFiles: loadSubagentFiles(fixturePath(idOf("1ccce9c5"))) });
    expect(formatReport(forked.report)).toMatch(/by 1 subagent that no step on this branch launched/);
  });
});
