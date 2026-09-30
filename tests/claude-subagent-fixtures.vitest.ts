import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseClaudeCode } from "../src/adapters/claude-code.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { prepareShare } from "../src/pipeline.js";
import { listSessions } from "../src/resolve.js";
import { SHARE_MODES } from "../src/schema.js";
import { makeScrub, privacyProblems, trimEntries } from "../scripts/sanitize-claude-fixtures.mjs";
import {
  SUBAGENT_FIXTURES_DIR,
  SUBAGENT_FIXTURES_PROJECT,
  SUBAGENT_FIXTURES_ROOT,
  costStateTotals,
  fixtureSessionIds,
  loadSubagentFixture,
  transcriptTotals,
  uniqueUsage,
  type Line,
  type SubagentFixture,
} from "./subagent-fixtures.js";

const ids = fixtureSessionIds();
const fixtures = new Map<string, SubagentFixture>(ids.map((id) => [id, loadSubagentFixture(id)]));
const fx = (prefix: string): SubagentFixture => fixtures.get(ids.find((id) => id.startsWith(prefix))!)!;

/** Launch shapes the fixtures are meant to cover, keyed by session id prefix. */
const SHAPES: Record<string, { agents: number; results: string[]; notifications: number; requestShapes: string[]; note: string }> = {
  "2b450029": { agents: 2, results: ["async_launched", "async_launched"], notifications: 2, requestShapes: ["background", "background"], note: "two background launches, -p mode" },
  "9150e1c1": { agents: 1, results: ["async_launched"], notifications: 1, requestShapes: ["background"], note: "background launch, interactive" },
  "491c3f9b": { agents: 1, results: ["completed"], notifications: 0, requestShapes: ["foreground"], note: "foreground, tool_result carries usage" },
  "9a69feab": { agents: 1, results: ["completed"], notifications: 0, requestShapes: ["foreground"], note: "custom reviewer agent on another model" },
  "bf3c7500": { agents: 3, results: ["completed", "completed", "completed"], notifications: 0, requestShapes: ["foreground", "foreground", "foreground"], note: "three parallel launches" },
  "2a10ef7b": { agents: 1, results: ["completed"], notifications: 0, requestShapes: ["foreground"], note: "Opus 5.5 fast mode" },
  "edf2048e": { agents: 1, results: ["completed"], notifications: 0, requestShapes: ["foreground"], note: "Opus 5.5 standard mode" },
};

const agentLaunches = (lines: Line[]) =>
  lines.flatMap((l) => (l.type === "assistant" ? (l.message?.content ?? []).filter((b: Line) => b.type === "tool_use" && (b.name === "Agent" || b.name === "Task")) : []));

describe("subagent fixture layout", () => {
  it("has one session per documented shape, laid out like ~/.claude/projects", () => {
    expect(ids.map((id) => id.slice(0, 8))).toEqual(Object.keys(SHAPES).sort());
    const listed = listSessions("claude-code", { "claude-code": SUBAGENT_FIXTURES_ROOT, pi: "" });
    // agent-*.jsonl files sit below <id>/subagents/ and never show up as sessions of their own.
    expect(listed.map((r) => r.id).sort()).toEqual(ids);
    expect(readdirSync(SUBAGENT_FIXTURES_ROOT).filter((f) => f !== "README.md")).toEqual([SUBAGENT_FIXTURES_PROJECT]);
  });

  it("gives every subagent a .jsonl and a .meta.json, and links it to the launching tool_use", () => {
    for (const f of fixtures.values()) {
      const dir = join(SUBAGENT_FIXTURES_DIR, f.id, "subagents");
      const files = readdirSync(dir).sort();
      expect(files, f.id).toEqual(f.subagents.flatMap((s) => [`agent-${s.agentId}.jsonl`, `agent-${s.agentId}.meta.json`]).sort());
      const launches = agentLaunches(f.main).map((b: Line) => b.id);
      expect(f.subagents.map((s) => s.meta.toolUseId).sort(), f.id).toEqual([...launches].sort());
    }
  });

  it("covers each launch shape", () => {
    for (const [prefix, want] of Object.entries(SHAPES)) {
      const f = fx(prefix);
      expect(agentLaunches(f.main), `${prefix} ${want.note}`).toHaveLength(want.agents);
      const results = f.main.flatMap((l) => (l.toolUseResult && typeof l.toolUseResult === "object" && "agentId" in l.toolUseResult ? [l.toolUseResult.status] : []));
      expect(results, prefix).toEqual(want.results);
      expect(f.main.filter((l) => l.origin?.kind === "task-notification"), prefix).toHaveLength(want.notifications);
      expect(f.subagents.map((s) => s.meta.requestShape), prefix).toEqual(want.requestShapes);
    }
    // Completed launches carry a usage object on the tool_result; async ones carry none.
    const completed = fx("491c3f9b").main.find((l) => l.toolUseResult?.status === "completed")!.toolUseResult;
    expect(completed).toMatchObject({ totalToolUseCount: 1, usage: expect.any(Object), totalTokens: expect.any(Number) });
    expect(fx("2b450029").main.some((l) => l.toolUseResult?.usage)).toBe(false);
    // Parallel launches share one assistant message.
    const parallelMsg = fx("bf3c7500").main.filter((l) => l.type === "assistant" && l.message.content?.[0]?.name === "Agent").map((l) => l.message.id);
    expect(new Set(parallelMsg).size).toBe(1);
    expect(parallelMsg).toHaveLength(3);
  });

  it("keeps main and subagent files apart: sidechain flag, distinct message ids", () => {
    for (const f of fixtures.values()) {
      expect(f.main.some((l) => l.isSidechain === true), f.id).toBe(false);
      const mainIds = new Set([...uniqueUsage([f.main]).keys()]);
      for (const s of f.subagents) {
        const assistants = s.lines.filter((l) => l.type === "assistant");
        expect(assistants.length, s.agentId).toBeGreaterThan(0);
        expect(s.lines.every((l) => l.isSidechain === true), s.agentId).toBe(true);
        for (const id of uniqueUsage([s.lines]).keys()) expect(mainIds.has(id), `${f.id} ${id}`).toBe(false);
      }
    }
  });
});

describe("cost-state cross-check", () => {
  // The invariant found in ass-rc52: Claude Code's cost-state includes subagent spend, and summing
  // unique message ids over the main file and every subagent file reproduces it exactly.
  const reconciled = ids.filter((id) => !id.startsWith("9150e1c1"));

  for (const id of reconciled) {
    it(`${id.slice(0, 8)}: main + subagent files sum to cost-state on all four token fields, per model`, () => {
      const f = fixtures.get(id)!;
      expect(transcriptTotals(f)).toEqual(costStateTotals(f));
    });
  }

  it("main alone does not: the subagent files carry spend the main transcript lacks", () => {
    for (const id of reconciled) {
      const f = fixtures.get(id)!;
      const mainOnly = transcriptTotals({ ...f, subagents: [] });
      const cost = costStateTotals(f);
      const sum = (t: Record<string, { output: number }>) => Object.values(t).reduce((n, m) => n + m.output, 0);
      expect(sum(mainOnly), id).toBeLessThan(sum(cost));
    }
  });

  it("9150e1c1 (interactive background run) is not reconciled: cost-state holds calls no file shows", () => {
    const f = fx("9150e1c1");
    const transcript = transcriptTotals(f)["claude-haiku-4-5-20251001"]!;
    const cost = costStateTotals(f)["claude-haiku-4-5-20251001"]!;
    expect(Object.keys(costStateTotals(f))).toEqual(Object.keys(transcriptTotals(f)));
    // Never the other way round: what the files show is a subset of what Claude Code billed.
    for (const k of ["input", "output", "cacheRead", "cacheWrite"] as const) expect(transcript[k], k).toBeLessThanOrEqual(cost[k]);
    // The gap is pinned so a change in how we count (or a new fixture) is noticed.
    expect({
      input: cost.input - transcript.input,
      output: cost.output - transcript.output,
      cacheRead: cost.cacheRead - transcript.cacheRead,
      cacheWrite: cost.cacheWrite - transcript.cacheWrite,
    }).toEqual({ input: 1648, output: 890, cacheRead: 71616, cacheWrite: 372 });
  });

  it("deduplicates a response split over several lines by keeping its largest usage", () => {
    // While streaming, the first line of a response carries a partial output count (4), the last the final one (135).
    const lines = fx("2b450029").subagents[0]!.lines.filter((l) => l.type === "assistant");
    const byId = Map.groupBy(lines, (l) => l.message.id as string);
    const partial = [...byId.values()].find((g) => new Set(g.map((l) => l.message.usage.output_tokens)).size > 1)!;
    expect(partial.map((l) => l.message.usage.output_tokens)).toEqual([4, 135]);
    expect(uniqueUsage([lines]).size).toBe(byId.size);
    expect(uniqueUsage([lines]).get(partial[0]!.message.id)!.usage.output_tokens).toBe(135);
    // Order does not matter.
    expect(uniqueUsage([[...lines].reverse()]).get(partial[0]!.message.id)!.usage.output_tokens).toBe(135);
  });

  it("prefers the copy in the earlier file (main) when an id appears in two files, even if the later one is larger", () => {
    const line = (output: number, file: string): Line => ({
      type: "assistant",
      message: { id: "msg_dup", model: "m", usage: { input_tokens: 1, output_tokens: output, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, file },
    });
    const main = [line(10, "main")];
    const sidechain = [line(500, "sidechain")];
    expect(uniqueUsage([main, sidechain]).get("msg_dup")!.usage.output_tokens).toBe(10);
    expect(uniqueUsage([sidechain, main]).get("msg_dup")!.usage.output_tokens).toBe(500);
    // Within one file the largest still wins.
    expect(uniqueUsage([[line(10, "a"), line(40, "a"), line(20, "a")]]).get("msg_dup")!.usage.output_tokens).toBe(40);
  });
});

describe("usage details the adapter ticket relies on", () => {
  const writes = (lines: Line[]) => [...uniqueUsage([lines]).values()].map((u) => u.usage.cache_creation ?? {});

  it("subagents wrote 5m cache while the main session wrote 1h, in every session", () => {
    for (const f of fixtures.values()) {
      const main = writes(f.main);
      expect(main.length, f.id).toBeGreaterThan(0);
      expect(main.every((w) => w.ephemeral_1h_input_tokens > 0 && w.ephemeral_5m_input_tokens === 0), `${f.id} main`).toBe(true);
      for (const s of f.subagents) {
        const sub = writes(s.lines);
        expect(sub.every((w) => w.ephemeral_5m_input_tokens > 0 && w.ephemeral_1h_input_tokens === 0), `${f.id} ${s.agentId}`).toBe(true);
      }
    }
  });

  it("9a69feab mixes models: Sonnet main, Haiku reviewer", () => {
    const f = fx("9a69feab");
    const models = (lines: Line[]) => [...new Set([...uniqueUsage([lines]).values()].map((u) => u.model))];
    expect(models(f.main)).toEqual(["claude-sonnet-5-5"]);
    expect(models(f.subagents[0]!.lines)).toEqual(["claude-haiku-4-5-20251001"]);
    expect(f.subagents[0]!.meta.agentType).toBe("reviewer");
    expect(Object.keys(costStateTotals(f)).sort()).toEqual(["claude-haiku-4-5-20251001", "claude-sonnet-5-5"]);
    // The reviewer made 9 model calls and 18 tool uses; the tool_result agrees on the latter.
    expect(uniqueUsage([f.subagents[0]!.lines]).size).toBe(9);
    expect(f.main.find((l) => l.toolUseResult?.status === "completed")!.toolUseResult.totalToolUseCount).toBe(18);
  });

  it("the foreground tool_result reports only the last subagent call, not a total", () => {
    const f = fx("491c3f9b");
    const result = f.main.find((l) => l.toolUseResult?.status === "completed")!.toolUseResult;
    const calls = [...uniqueUsage([f.subagents[0]!.lines]).values()].map((u) => u.usage);
    const total = (u: Line) => u.input_tokens + u.output_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens;
    expect(result.totalTokens).toBe(total(calls.at(-1)!));
    expect(result.totalTokens).toBeLessThan(calls.reduce((n, u) => n + total(u), 0));
  });

  it("marks fast mode on every call of the fast Opus session and on none of the standard one", () => {
    const speeds = (f: SubagentFixture) => [...uniqueUsage([f.main, ...f.subagents.map((s) => s.lines)]).values()].map((u) => u.usage.speed);
    expect(new Set(speeds(fx("2a10ef7b")))).toEqual(new Set(["fast"]));
    expect(new Set(speeds(fx("edf2048e")))).toEqual(new Set(["standard"]));
  });
});

describe("the existing pipeline accepts the fixtures", () => {
  const machine = { homeDir: "/home/fixture-user", username: "fixture-user" };

  for (const id of ids) {
    it(`${id.slice(0, 8)}: parses to a single human turn and exports clean in every mode`, () => {
      const raw = readFileSync(fx(id).mainPath, "utf8");
      const { session } = parseClaudeCode(raw);
      expect(session.turns).toHaveLength(1);
      expect(session.source.sessionId).toBe(id);
      expect(session.project?.cwd).toBe("/home/fixture-user/work/usage-sandbox");
      for (const mode of SHARE_MODES) {
        const { report, json } = prepareShare(raw, { mode, config: DEFAULT_CONFIG, harness: "claude-code", machine, knownSecrets: [] });
        expect(report.blocked, `${id} ${mode}`).toBe(false);
        expect(report.clean, `${id} ${mode}`).toBe(true);
        expect(json).not.toContain("<task-notification");
      }
    });
  }
});

describe("fixture hygiene", () => {
  const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : [join(dir, f)]));
  const all = files(SUBAGENT_FIXTURES_ROOT).filter((f) => /\.(jsonl|json)$/.test(f));

  it("has no personal paths, emails, account ids or temp directories", () => {
    // 7 main files, plus a transcript and a meta file per subagent.
    expect(all.length).toBe(ids.length + 2 * [...fixtures.values()].reduce((n, f) => n + f.subagents.length, 0));
    for (const path of all) {
      const text = readFileSync(path, "utf8");
      expect(privacyProblems(text, "/home/nobody", "nobody"), path).toEqual([]);
      for (const m of text.matchAll(/\/home\/[A-Za-z0-9._-]+/g)) expect(m[0], path).toBe("/home/fixture-user");
    }
  });

  it("carries only the small injected-context attachments", () => {
    const kept = new Set<string>();
    for (const path of all.filter((f) => f.endsWith(".jsonl"))) {
      for (const l of readFileSync(path, "utf8").split("\n").filter(Boolean)) {
        const e = JSON.parse(l) as Line;
        if (e.type === "attachment") kept.add(e.attachment.type);
        expect(l.length, path).toBeLessThan(9000);
      }
    }
    // queued_command (a prompt typed while the agent was busy) is the one other type the sanitizer keeps.
    kept.delete("queued_command");
    expect([...kept].sort()).toEqual(["budget_usd", "date", "model", "total_tokens_reminder"]);
  });

  it("keeps every parent link resolvable, with exactly one root per file", () => {
    for (const path of all.filter((f) => f.endsWith(".jsonl"))) {
      const lines = readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Line);
      const uuids = new Set(lines.flatMap((l) => (typeof l.uuid === "string" ? [l.uuid] : [])));
      for (const l of lines) for (const k of ["parentUuid", "logicalParentUuid", "leafUuid"]) if (l[k]) expect(uuids.has(l[k]), `${path} ${k}`).toBe(true);
      expect(lines.filter((l) => l.uuid && l.parentUuid === null), path).toHaveLength(1);
    }
  });
});

describe("sanitizer", () => {
  it("runs from a path that needs URL encoding", () => {
    const dir = mkdtempSync(join(tmpdir(), "as san "));
    const copy = join(dir, "sanitize #1.mjs");
    copyFileSync(join(import.meta.dirname, "..", "scripts", "sanitize-claude-fixtures.mjs"), copy);
    // No arguments: it must print its usage and exit 2, not silently do nothing.
    const run = spawnSync(process.execPath, [copy], { encoding: "utf8" });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("usage:");
  });

  it("keeps queued prompts, which the adapter turns into turns", () => {
    const entries = [
      { type: "user", uuid: "a", parentUuid: null },
      { type: "attachment", uuid: "b", parentUuid: "a", attachment: { type: "queued_command", commandMode: "prompt", prompt: "next" } },
    ];
    expect(trimEntries(entries).map((e) => e.uuid)).toEqual(["a", "b"]);
  });

  const home = "/home/alice";
  const scrub = makeScrub(home, "alice");

  it("replaces home, cwd, project slug, temp task paths and username", () => {
    const line = JSON.stringify({
      cwd: "/home/alice/workspace/usage-sandbox",
      file: "/home/alice/workspace/usage-sandbox/a.js",
      out: "/home/alice/.tmp/claude-1000/-home-alice-workspace-usage-sandbox/abc/tasks/x.output",
      other: "/home/alice/notes.md",
      by: "alice",
    });
    const out = scrub(line);
    expect(out).toBe(
      JSON.stringify({
        cwd: "/home/fixture-user/work/usage-sandbox",
        file: "/home/fixture-user/work/usage-sandbox/a.js",
        out: "/tmp/claude-fixture/-home-fixture-user-work-usage-sandbox/abc/tasks/x.output",
        other: "/home/fixture-user/notes.md",
        by: "fixture-user",
      }),
    );
    expect(privacyProblems(out, home, "alice")).toEqual([]);
  });

  it("does not rewrite words that merely contain the username", () => {
    expect(scrub("malicealice alice-x")).toBe("malicealice fixture-user-x");
  });

  it("refuses output that still looks private", () => {
    expect(privacyProblems('{"p":"/home/alice/x"}', home, "alice")).toHaveLength(2);
    expect(privacyProblems('"a@example.com"', home, "alice")).toContain("contains an email address");
    expect(privacyProblems('{"organizationUuid":"x"}', home, "alice")).toContain("contains account identifiers");
    expect(privacyProblems('"/tmp/.tmp/x"', home, "alice")).toContain("contains a temp path");
  });

  it("drops large attachments and re-links parents over them", () => {
    const entries = [
      { type: "user", uuid: "a", parentUuid: null },
      { type: "attachment", uuid: "b", parentUuid: "a", attachment: { type: "prompt_snapshot" } },
      { type: "attachment", uuid: "c", parentUuid: "b", attachment: { type: "skill_listing" } },
      { type: "attachment", uuid: "d", parentUuid: "c", attachment: { type: "date" } },
      { type: "assistant", uuid: "e", parentUuid: "d" },
      { type: "attachment", uuid: "f", parentUuid: "e", attachment: { type: "credential_org" } },
      { type: "assistant", uuid: "g", parentUuid: "f" },
      { type: "file-history-snapshot", messageId: "a" },
      { type: "last-prompt", leafUuid: "f" },
      { type: "cost-state", modelUsage: {} },
    ];
    const out = trimEntries(entries);
    expect(out.map((e) => e.uuid ?? e.type)).toEqual(["a", "d", "e", "g", "last-prompt", "cost-state"]);
    expect(out.map((e) => e.parentUuid)).toEqual([null, "a", "d", "e", undefined, undefined]);
    expect(out.find((e) => e.type === "last-prompt")!.leafUuid).toBe("e");
  });
});
