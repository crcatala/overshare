import { describe, expect, it } from "vitest";
import { parseClaudeCode } from "../src/adapters/claude-code.js";
import { parsePi } from "../src/adapters/pi.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { describeCost, formatSessionCost, formatTokens, formatUsageTotals } from "../src/format.js";
import { prepareShare } from "../src/pipeline.js";
import { formatReport } from "../src/report.js";
import { SHARE_MODES } from "../src/schema.js";
import { computeStats } from "../src/stats.js";
import { ClaudeTranscript, PiTranscript, ccUsage, piUsage } from "./helpers.js";

const OPUS = "claude-opus-5-5";
const stats = (raw: string, harness: "claude" | "pi") => computeStats((harness === "claude" ? parseClaudeCode(raw) : parsePi(raw)).session);

describe("Claude Code usage", () => {
  it("keeps the repeat of a streamed message with the most tokens", () => {
    // Older Claude Code wrote growing snapshots: output_tokens 1 on the first line, the total on the last.
    const t = new ClaudeTranscript()
      .user("go")
      .assistant("m1", [{ type: "text", text: "a" }], ccUsage(7, 1, 34000, 347), OPUS)
      .assistant("m1", [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }], ccUsage(7, 100, 34000, 347), OPUS)
      .assistant("m1", [{ type: "text", text: "b" }], ccUsage(7, 40, 34000, 347), OPUS);
    const { session } = parseClaudeCode(t.toJsonl());
    expect(session.responses).toHaveLength(1);
    expect(session.responses[0]!.usage.output).toBe(100);
  });

  it("estimates each call's cost at list price and keeps the 1h/5m cache-write split", () => {
    const withSplit = { ...ccUsage(10, 50, 1000, 200), cache_creation: { ephemeral_5m_input_tokens: 50, ephemeral_1h_input_tokens: 150 } };
    const t = new ClaudeTranscript().user("go").assistant("m1", [{ type: "text", text: "a" }], withSplit, OPUS).assistant("m2", [{ type: "text", text: "b" }], ccUsage(10, 50, 1000, 200), OPUS);
    const { session } = parseClaudeCode(t.toJsonl());
    expect(session.responses[0]!.usage.cacheWrite1h).toBe(150);
    expect(session.responses[1]!.usage.cacheWrite1h).toBeUndefined();
    // 40 + 1000 + 200 + 50*5 + 150*8 (per million) versus all 200 at the 5m rate.
    expect(session.responses[0]!.usage.cost).toBeCloseTo((40 + 1000 + 200 + 250 + 1200) / 1e6, 12);
    expect(session.responses[1]!.usage.cost).toBeCloseTo(2240 / 1e6, 12);
    const st = computeStats(session);
    expect(st).toMatchObject({ costSource: "estimated" });
    expect(st.costPartial).toBeUndefined();
    expect(st.cost).toBeCloseTo((2690 + 2240) / 1e6, 12);
    expect(st.tokens.cacheWrite1h).toBe(150);
  });

  it("ignores Claude Code's own cost total, which only covers the last process of a resumed session", () => {
    const t = new ClaudeTranscript()
      .user("go")
      .assistant("m1", [{ type: "text", text: "a" }], ccUsage(10, 50, 1000, 200), OPUS)
      .meta("cost-state", { totalCostUSD: 99, startTime: Date.UTC(2026, 0, 2) });
    const st = stats(t.toJsonl(), "claude");
    expect(st.cost).toBeCloseTo(2240 / 1e6, 12);
  });

  it("never prices an unknown model at zero: no cost, or a lower bound when only some calls are unpriced", () => {
    const unknown = new ClaudeTranscript().user("go").assistant("m1", [{ type: "text", text: "a" }], ccUsage(10, 50, 1000, 200), "claude-unreleased-9");
    const none = stats(unknown.toJsonl(), "claude");
    expect(none.cost).toBeUndefined();
    expect(none.costPartial).toBeUndefined();
    expect(formatSessionCost(none)).toBeUndefined();

    const mixed = new ClaudeTranscript()
      .user("go")
      .assistant("m1", [{ type: "text", text: "a" }], ccUsage(10, 50, 1000, 200), OPUS)
      .assistant("m2", [{ type: "text", text: "b" }], ccUsage(10, 50, 1000, 200), "claude-unreleased-9");
    const part = stats(mixed.toJsonl(), "claude");
    expect(part.cost).toBeCloseTo(2240 / 1e6, 12);
    expect(part.costPartial).toBe(true);
    expect(formatSessionCost(part)).toMatch(/\+$/);
    expect(describeCost(part).join(" ")).toMatch(/lower bound/);
    // An estimate says it can undercount; a cost the agent recorded itself does not.
    expect(describeCost(part).join(" ")).toMatch(/Can undercount/);
    expect(describeCost({ ...part, costSource: "per-response" }).join(" ")).not.toMatch(/Can undercount/);
  });

  it("reports spend on rewound branches separately from the exported branch", () => {
    const t = new ClaudeTranscript().user("q").assistant("m1", [{ type: "text", text: "a" }], ccUsage(10, 50, 1000, 200), OPUS);
    const fork = t.lastUuid;
    t.user("old path").assistant("mOld", [{ type: "text", text: "old" }], ccUsage(4, 30, 2000, 0), OPUS);
    t.rewindTo(fork).user("new path").assistant("mNew", [{ type: "text", text: "new" }], ccUsage(5, 20, 1500, 0), OPUS);
    const st = stats(t.toJsonl(), "claude");
    expect(st.responses).toBe(2);
    expect(st.tokens).toMatchObject({ input: 15, output: 70, cacheRead: 2500 });
    expect(st.otherBranches).toMatchObject({ responses: 1, tokens: { input: 4, output: 30, cacheRead: 2000 } });
    expect(st.otherBranches!.cost).toBeCloseTo((16 + 600 + 400) / 1e6, 12);
    expect(st.cost).toBeCloseTo((2240 + (20 + 400 + 300)) / 1e6, 12);
  });

  it("has no other-branch usage for a linear session, and leaves subagent (sidechain) lines out of every total", () => {
    const t = new ClaudeTranscript().user("q").assistant("m1", [{ type: "text", text: "a" }], ccUsage(10, 50, 1000, 200), OPUS);
    t.lines.push({ ...t.lines.at(-1), uuid: "side-1", isSidechain: true, message: { id: "mSide", model: OPUS, role: "assistant", content: [{ type: "text", text: "x" }], usage: ccUsage(1, 999, 0, 0) } });
    const st = stats(t.toJsonl(), "claude");
    expect(st.otherBranches).toBeUndefined();
    expect(st.tokens.output).toBe(50);
  });

  it("keeps history before a compaction on the branch, and still reports rewound spend", () => {
    const t = new ClaudeTranscript().user("q").assistant("m1", [{ type: "text", text: "a" }], ccUsage(10, 50, 1000, 200), OPUS);
    const fork = t.lastUuid;
    t.user("old path").assistant("mOld", [{ type: "text", text: "old" }], ccUsage(4, 30, 2000, 0), OPUS);
    t.rewindTo(fork).user("go on").assistant("m2", [{ type: "text", text: "b" }], ccUsage(5, 20, 1500, 0), OPUS);
    // After a compaction the boundary has no parent and links back through logicalParentUuid.
    t.system("compact_boundary", { parentUuid: null, logicalParentUuid: t.lastUuid, compactMetadata: { trigger: "manual", preTokens: 90_000 } });
    t.user("after").assistant("m3", [{ type: "text", text: "c" }], ccUsage(6, 10, 500, 100), OPUS);
    const { session } = parseClaudeCode(t.toJsonl());
    expect(session.responses.map((r) => r.id)).toEqual(["m1", "m2", "m3"]);
    expect(session.turns.flatMap((x) => x.steps).some((s) => s.kind === "event" && s.event === "compaction")).toBe(true);
    const st = computeStats(session);
    expect(st.compactions).toBe(1);
    expect(st.otherBranches).toMatchObject({ responses: 1, tokens: { input: 4, output: 30, cacheRead: 2000 } });
  });

  it("marks off-branch cost as a lower bound when some of those calls are unpriced", () => {
    const t = new ClaudeTranscript().user("q").assistant("m1", [{ type: "text", text: "a" }], ccUsage(10, 50, 1000, 200), OPUS);
    const fork = t.lastUuid;
    t.user("old").assistant("mA", [{ type: "text", text: "x" }], ccUsage(4, 30, 2000, 0), OPUS).assistant("mB", [{ type: "text", text: "y" }], ccUsage(4, 30, 2000, 0), "claude-unreleased-9");
    t.rewindTo(fork).user("new").assistant("mNew", [{ type: "text", text: "z" }], ccUsage(5, 20, 1500, 0), OPUS);
    const other = stats(t.toJsonl(), "claude").otherBranches!;
    expect(other.responses).toBe(2);
    expect(other.costPartial).toBe(true);
    expect(formatUsageTotals(other)).toMatch(/\+$/);

    const allUnpriced = new ClaudeTranscript().user("q").assistant("m1", [{ type: "text", text: "a" }], ccUsage(10, 50, 1000, 200), OPUS);
    const f = allUnpriced.lastUuid;
    allUnpriced.user("old").assistant("mB", [{ type: "text", text: "y" }], ccUsage(4, 30, 2000, 0), "claude-unreleased-9");
    allUnpriced.rewindTo(f).user("new").assistant("mNew", [{ type: "text", text: "z" }], ccUsage(5, 20, 1500, 0), OPUS);
    const none = stats(allUnpriced.toJsonl(), "claude").otherBranches!;
    expect(none.cost).toBeUndefined();
    expect(none.costPartial).toBeUndefined();
  });
});

describe("pi usage", () => {
  it("keeps recorded per-call cost, and does not count aborted calls that report nothing", () => {
    const t = new PiTranscript().user("go");
    t.assistant([{ type: "text", text: "a" }], piUsage(100, 10, 500, 0, 0.01));
    t.assistant([], piUsage(0, 0), { stopReason: "aborted", errorMessage: "Operation aborted" });
    t.assistant([], piUsage(0, 0), { stopReason: "error", errorMessage: "boom" });
    const { session } = parsePi(t.toJsonl());
    expect(session.responses).toHaveLength(1);
    // The interruption is still in the transcript.
    expect(session.turns.flatMap((x) => x.steps).map((s) => (s.kind === "event" ? s.event : s.kind))).toEqual(["text", "interrupted", "error"]);
    expect(computeStats(session)).toMatchObject({ responses: 1, cost: 0.01, costSource: "per-response" });
  });

  it("counts an aborted call that did report tokens", () => {
    const t = new PiTranscript().user("go");
    t.assistant([{ type: "text", text: "partial" }], piUsage(100, 3, 0, 0, 0.001), { stopReason: "aborted" });
    expect(parsePi(t.toJsonl()).session.responses).toHaveLength(1);
  });

  it("counts compaction, branch summary, tool and keep-alive usage as model calls with a purpose", () => {
    const t = new PiTranscript().user("go");
    t.assistant([{ type: "text", text: "a" }], piUsage(100, 10, 0, 0, 0.01));
    t.entry("compaction", { summary: "s", tokensBefore: 90000, firstKeptEntryId: "x", usage: piUsage(69232, 1139, 0, 0, 0.0152, 154) });
    t.entry("branch_summary", { summary: "b", fromId: "x", usage: piUsage(500, 50, 0, 0, 0.002) });
    t.entry("usage", { kind: "cache_warm", provider: "anthropic", model: "claude-opus-5-5", usage: piUsage(1, 1, 30000, 0, 0.006) });
    t.entry("message", { message: { role: "toolResult", toolCallId: "none", toolName: "helper", content: [{ type: "text", text: "ok" }], usage: piUsage(300, 30, 0, 0, 0.003) } });
    const { session } = parsePi(t.toJsonl());
    expect(session.responses.map((r) => r.purpose)).toEqual([undefined, "compaction", "summary", "cache-warm", "tool"]);
    expect(session.responses[3]!.model).toBe("claude-opus-5-5");
    const st = computeStats(session);
    expect(st.responses).toBe(5);
    expect(st.tokens).toMatchObject({ input: 100 + 69232 + 500 + 1 + 300, output: 10 + 1139 + 50 + 1 + 30 });
    expect(st.cost).toBeCloseTo(0.01 + 0.0152 + 0.002 + 0.006 + 0.003, 10);
  });

  it("falls back to the provider's total when only that is reported, and keeps the 1h cache-write split", () => {
    const t = new PiTranscript().user("go");
    t.assistant([{ type: "text", text: "a" }], { totalTokens: 333 });
    t.assistant([{ type: "text", text: "b" }], { ...piUsage(10, 5, 100, 40, 0.01), cacheWrite1h: 25 });
    const { session } = parsePi(t.toJsonl());
    expect(session.responses[0]!.usage).toMatchObject({ input: 0, output: 333 });
    expect(session.responses[1]!.usage.cacheWrite1h).toBe(25);
  });

  it("reports spend on abandoned branches separately", () => {
    const t = new PiTranscript().user("first").assistant([{ type: "text", text: "a1" }], piUsage(100, 10, 0, 0, 0.01));
    const fork = t.lastId;
    t.user("old").assistant([{ type: "text", text: "a2" }], piUsage(200, 20, 0, 0, 0.02));
    t.branchFrom(fork).user("new").assistant([{ type: "text", text: "a3" }], piUsage(300, 30, 0, 0, 0.03));
    const st = stats(t.toJsonl(), "pi");
    expect(st).toMatchObject({ responses: 2, cost: 0.04, tokens: { input: 400, output: 40 } });
    expect(st.otherBranches).toMatchObject({ responses: 1, cost: 0.02, tokens: { input: 200, output: 20 } });
  });

  it("splits a fork's inherited history from its own spend", () => {
    const t = new PiTranscript().user("parent q").assistant([{ type: "text", text: "p1" }], piUsage(100, 10, 0, 0, 0.01));
    t.user("parent q2").assistant([{ type: "text", text: "p2" }], piUsage(150, 15, 0, 0, 0.015));
    // The fork header is stamped after the copied entries (entries e1-e4 are one second apart from 00:00:01).
    const header = t.lines[0] as Record<string, unknown>;
    header.parentSession = "/somewhere/parent.jsonl";
    header.timestamp = "2026-01-01T00:00:04.500Z";
    t.user("child q").assistant([{ type: "text", text: "c1" }], piUsage(300, 30, 0, 0, 0.03));
    const { session } = parsePi(t.toJsonl());
    expect(session.responses.map((r) => !!r.inherited)).toEqual([true, true, false]);
    const st = computeStats(session);
    // Totals are this session's own work; the parent's spend is reported apart and still drawn in the charts.
    expect(st).toMatchObject({ responses: 1, cost: 0.03, tokens: { input: 300, output: 30 } });
    expect(st.inherited).toMatchObject({ responses: 2, cost: 0.025, tokens: { input: 250, output: 25 } });
    expect(st.peakContext).toBe(300);
  });

  it("counts a usage entry on an abandoned branch as other-branch spend", () => {
    const t = new PiTranscript().user("first").assistant([{ type: "text", text: "a1" }], piUsage(100, 10, 0, 0, 0.01));
    const fork = t.lastId;
    t.entry("usage", { kind: "cache_warm", provider: "p", model: "m", usage: piUsage(1, 1, 30000, 0, 0.006) });
    t.branchFrom(fork).user("new").assistant([{ type: "text", text: "a3" }], piUsage(300, 30, 0, 0, 0.03));
    const st = stats(t.toJsonl(), "pi");
    expect(st).toMatchObject({ responses: 2, cost: 0.04 });
    expect(st.otherBranches).toMatchObject({ responses: 1, cost: 0.006, tokens: { input: 1, output: 1, cacheRead: 30000 } });
  });

  it("does not count an abandoned branch of the parent's history as the fork's other-branch spend", () => {
    const t = new PiTranscript().user("p1").assistant([{ type: "text", text: "a1" }], piUsage(100, 10, 0, 0, 0.01));
    const fork = t.lastId;
    t.user("abandoned").assistant([{ type: "text", text: "ab" }], piUsage(200, 20, 0, 0, 0.02));
    t.branchFrom(fork).user("p2").assistant([{ type: "text", text: "a2" }], piUsage(150, 15, 0, 0, 0.015));
    const header = t.lines[0] as Record<string, unknown>;
    header.parentSession = "/somewhere/parent.jsonl";
    header.timestamp = "2026-01-01T00:00:06.500Z"; // after the parent's six entries, before the child's
    t.user("child").assistant([{ type: "text", text: "c1" }], piUsage(300, 30, 0, 0, 0.03));
    const st = stats(t.toJsonl(), "pi");
    // The parent's abandoned branch belongs to the parent: it is neither inherited nor this session's other branch.
    expect(st.inherited).toMatchObject({ responses: 2, cost: 0.025 });
    expect(st.otherBranches).toBeUndefined();
    expect(st).toMatchObject({ responses: 1, cost: 0.03 });
  });

  it("treats entries without a usable timestamp as this session's own", () => {
    const build = (headerTimestamp: string, dropStamp = false) => {
      const t = new PiTranscript().user("p").assistant([{ type: "text", text: "a1" }], piUsage(100, 10, 0, 0, 0.01));
      const header = t.lines[0] as Record<string, unknown>;
      header.parentSession = "/somewhere/parent.jsonl";
      header.timestamp = headerTimestamp;
      if (dropStamp) delete (t.lines[2] as Record<string, unknown>).timestamp;
      return t.toJsonl();
    };
    // Fork header stamped after the copied entries: inherited...
    expect(stats(build("2026-01-01T00:01:00.000Z"), "pi").inherited?.responses).toBe(1);
    // ...unless the entry has no timestamp to compare, or the header's is unparseable.
    expect(stats(build("2026-01-01T00:01:00.000Z", true), "pi").inherited).toBeUndefined();
    expect(stats(build("not a date"), "pi").inherited).toBeUndefined();
  });

  it("treats a session without a parent as having nothing inherited", () => {
    const t = new PiTranscript().user("q").assistant([{ type: "text", text: "a" }], piUsage(100, 10, 0, 0, 0.01));
    expect(stats(t.toJsonl(), "pi").inherited).toBeUndefined();
  });
});

describe("CLI report", () => {
  const machine = { homeDir: "/home/tester", username: "tester", hostname: "box" };
  const report = (raw: string) => formatReport(prepareShare(raw, { mode: "brief", config: DEFAULT_CONFIG, machine, knownSecrets: [] }).report);

  it("labels the cost an estimate and lists usage it did not count", () => {
    const t = new ClaudeTranscript().user("q").assistant("m1", [{ type: "text", text: "a" }], ccUsage(10, 50, 1000, 200), OPUS);
    const fork = t.lastUuid;
    t.user("old").assistant("mOld", [{ type: "text", text: "old" }], ccUsage(4, 30, 2000, 0), OPUS);
    t.rewindTo(fork).user("new").assistant("mNew", [{ type: "text", text: "new" }], ccUsage(5, 20, 1500, 0), OPUS);
    const text = report(t.toJsonl());
    expect(text).toMatch(/est\. cost \$0\.00\d/);
    expect(text).toMatch(/not counted: 1 call · .* tokens · \$0\.00\d on other branches/);
    expect(text).not.toMatch(/inherited/);
  });

  it("lists inherited history for a fork, and marks a lower-bound cost", () => {
    const t = new PiTranscript().user("p").assistant([{ type: "text", text: "a1" }], piUsage(100, 10, 0, 0, 0.01));
    const header = t.lines[0] as Record<string, unknown>;
    header.parentSession = "/somewhere/parent.jsonl";
    header.timestamp = "2026-01-01T00:00:02.500Z"; // after the parent's two entries
    t.user("child").assistant([{ type: "text", text: "c1" }], piUsage(300, 30, 0, 0, 0.03));
    t.assistant([{ type: "text", text: "c2" }], { input: 5, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 10 }); // no cost recorded
    const text = report(t.toJsonl());
    expect(text).toContain("est. cost $0.030+");
    expect(text).toMatch(/not counted: 1 call · .* tokens · \$0\.010 inherited from the parent session/);
  });
});

describe("share modes", () => {
  it("do not change the usage numbers", () => {
    const t = new ClaudeTranscript().user("q").assistant("m1", [{ type: "text", text: "a" }], ccUsage(10, 50, 1000, 200), OPUS);
    const fork = t.lastUuid;
    t.user("old").assistant("mOld", [{ type: "text", text: "old" }], ccUsage(4, 30, 2000, 0), OPUS);
    t.rewindTo(fork).user("new").assistant("mNew", [{ type: "text", text: "new" }], ccUsage(5, 20, 1500, 0), OPUS);
    const machine = { homeDir: "/home/tester", username: "tester", hostname: "box" };
    const byMode = SHARE_MODES.map((mode) => prepareShare(t.toJsonl(), { mode, config: DEFAULT_CONFIG, machine, knownSecrets: [] }).session);
    for (const s of byMode) {
      expect(s.stats.cost).toBeCloseTo(byMode[0]!.stats.cost!, 12);
      expect(s.stats.otherBranches).toEqual(byMode[0]!.stats.otherBranches);
      expect(s.stats.tokens).toEqual(byMode[0]!.stats.tokens);
      expect(s.responses).toHaveLength(2);
    }
  });
});

describe("formatTokens", () => {
  it("has a B tier", () => {
    expect(formatTokens(999_999)).toBe("1000k");
    expect(formatTokens(1_045_000_000)).toBe("1.0B");
    expect(formatTokens(12_400_000_000)).toBe("12B");
  });
});
