/**
 * Source line numbers for suspicious and blocked findings (ass-jgn2). The line comes from looking the value up in
 * the source transcript, never from the payload: these tests run the real pipeline over multi-turn Claude Code and
 * pi transcripts with planted fake secrets, check the line in every share mode, and check that nothing about a line
 * reaches the uploaded bytes or leaks the value.
 */
import { describe, expect, it, vi } from "vitest";
import { summarizeShare } from "../src/browse/job.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { prepareShare, type PrepareOptions } from "../src/pipeline.js";
import { knownSecret } from "../src/redact/known-values.js";
import { rescanPayload } from "../src/redact/rescan.js";
import { formatSourceLines, sourceLocator } from "../src/redact/source-lines.js";
import { formatReport } from "../src/report.js";
import type { ShareMode } from "../src/schema.js";
import { ClaudeTranscript, PiTranscript, ccUsage, fake, piUsage, randomish } from "./helpers.js";

const machine = { homeDir: "/home/tester", username: "tester", hostname: "box" };

const prepare = (raw: string, mode: ShareMode = "full", extra: Partial<PrepareOptions> = {}) =>
  prepareShare(raw, { mode, config: DEFAULT_CONFIG, machine, knownSecrets: [], now: new Date(0), ...extra });

/** Every way a finding reaches a reader. */
const surfaces = (p: ReturnType<typeof prepare>): string[] => [formatReport(p.report, { maxFindings: Infinity }), JSON.stringify(p.report), JSON.stringify(summarizeShare(p))];

const mediumKey = (value: string) => `db_password=${value}`;

describe("sourceLocator", () => {
  const locate = (raw: string, needle: string, name?: string) => sourceLocator([{ raw, ...(name ? { name } : {}) }])((t) => t.includes(needle));

  it("counts lines as an editor does: blank lines and a torn last line included", () => {
    const raw = ['{"a":"x"}', "", '{"a":"needle-1"}', "", "", '{"b":"y"}', '{"a":"needle-2'].join("\n");
    expect(locate(raw, "needle-1")?.hits).toEqual([{ line: 3 }]);
    // The torn line is not JSON, so it is searched as it is.
    expect(locate(raw, "needle-2")?.hits).toEqual([{ line: 7 }]);
  });

  it("decodes each line: a value that JSON escaped is still found, in a string or an object key", () => {
    const value = 'quote " and\nnewline and é';
    const raw = [JSON.stringify({ text: "plain" }), JSON.stringify({ text: `a ${value} b` }), JSON.stringify({ [value]: 1 })].join("\n");
    expect(raw).not.toContain(value); // escaped in the file, so a raw search could not find it
    expect(locate(raw, value)?.hits).toEqual([{ line: 2 }, { line: 3 }]);
  });

  it("caps the list but counts every line, and names the file of a hit outside the session file", () => {
    const line = JSON.stringify({ k: "needle" });
    const found = sourceLocator([
      { raw: Array.from({ length: 7 }, () => line).join("\n") },
      { name: "agent-a1.jsonl", raw: `\n${line}` },
    ])((t) => t === "needle")!;
    expect(found.total).toBe(8);
    expect(found.hits).toEqual([1, 2, 3, 4, 5].map((n) => ({ line: n })));
    expect(formatSourceLines(found)).toBe("lines 1, 2, 3, 4, 5 (+3 more)");
    const onlyAgent = sourceLocator([{ raw: line.replace("needle", "x") }, { name: "agent-a1.jsonl", raw: `\n${line}` }])((t) => t === "needle")!;
    expect(onlyAgent.hits).toEqual([{ file: "agent-a1.jsonl", line: 2 }]);
    expect(formatSourceLines(onlyAgent)).toBe("agent-a1.jsonl line 2");
  });

  it("finds nothing for a value that is not in the source, and reads the files only on the first lookup", () => {
    const parse = vi.spyOn(JSON, "parse");
    const find = sourceLocator([{ raw: JSON.stringify({ a: "b" }) }]);
    expect(parse).not.toHaveBeenCalled();
    expect(find((t) => t === "absent")).toBeUndefined();
    expect(parse).toHaveBeenCalled();
    parse.mockRestore();
  });

  it("formats one line, several lines and a mix of files without a value", () => {
    expect(formatSourceLines({ hits: [{ line: 42 }], total: 1 })).toBe("line 42");
    expect(formatSourceLines({ hits: [{ line: 4 }, { line: 9 }], total: 2 })).toBe("lines 4, 9");
    expect(formatSourceLines({ hits: [{ line: 4 }, { file: "agent-b2.jsonl", line: 1 }, { file: "agent-b2.jsonl", line: 3 }], total: 4 })).toBe("line 4; agent-b2.jsonl lines 1, 3 (+1 more)");
  });
});

describe("rescanPayload", () => {
  const payload = (turn: unknown) => JSON.stringify({ schema: "x", turns: [turn] });
  const planted = (value: string) => payload({ index: 0, steps: [{ kind: "tool", name: "Bash", id: "t1", input: { [mediumKey(value)]: 1 } }] });

  it("hands the locator a matcher, not the value, and attaches what it finds", () => {
    const value = randomish(16, 41);
    const seen: string[] = [];
    const result = rescanPayload(planted(value), {
      locate: (match) => {
        seen.push(String(match));
        expect(match(mediumKey(value))).toBe(true);
        expect(match("something else")).toBe(false);
        return { hits: [{ line: 7 }], total: 1 };
      },
    });
    expect(result.suspicious).toEqual([{ rule: "secret-assignment", length: value.length, location: "turn 1 · Bash · input (object key)", occurrences: 1, source: { hits: [{ line: 7 }], total: 1 } }]);
    expect(JSON.stringify(result)).not.toContain(value);
  });

  it("does not look anything up when there is nothing to report", () => {
    const locate = vi.fn();
    expect(rescanPayload(payload({ index: 0, steps: [{ kind: "text", id: "t1", text: "hello" }] }), { locate })).toEqual({ issues: [], suspicious: [] });
    expect(locate).not.toHaveBeenCalled();
  });

  it("looks up a bounded number of findings per scan", () => {
    const turn = { index: 0, steps: [{ kind: "tool", name: "Bash", id: "t1", input: Object.fromEntries(Array.from({ length: 120 }, (_, i) => [mediumKey(randomish(16, 100 + i)), 1])) }] };
    const locate = vi.fn(() => ({ hits: [{ line: 1 }], total: 1 }));
    const { suspicious } = rescanPayload(payload(turn), { locate });
    expect(suspicious.length).toBeGreaterThan(50);
    expect(locate).toHaveBeenCalledTimes(50);
    expect(suspicious.filter((s) => s.source)).toHaveLength(50);
  });

  it("a finding the source does not hold verbatim just has no lines", () => {
    const result = rescanPayload(planted(randomish(16, 41)), { locate: () => undefined });
    expect(result.suspicious).toHaveLength(1);
    expect(result.suspicious[0]).not.toHaveProperty("source");
  });
});

describe("Claude Code", () => {
  /** user, assistant (tool call), result, assistant | user, assistant | user, assistant (tool call with the planted key), result, assistant. */
  const transcript = (input: Record<string, unknown>, { blankBefore = 0 } = {}) => {
    const t = new ClaudeTranscript("aaaaaaaa-0000-0000-0000-000000000000", "/home/tester/work/demo")
      .user("first")
      .assistant("m1", [{ type: "tool_use", id: "b0", name: "Bash", input: { command: "ls" } }], ccUsage(1, 1))
      .toolResult("b0", "ok")
      .assistant("m2", [{ type: "text", text: "one" }], ccUsage(1, 1))
      .user("second")
      .assistant("m3", [{ type: "text", text: "two" }], ccUsage(1, 1))
      .user("third")
      .assistant("m4", [{ type: "tool_use", id: "b1", name: "Bash", input }], ccUsage(1, 1))
      .toolResult("b1", "ok")
      .assistant("m5", [{ type: "text", text: "done" }], ccUsage(1, 1));
    const lines = t.toJsonl().split("\n");
    lines.splice(0, 0, ...Array.from({ length: blankBefore }, () => ""));
    return lines.join("\n");
  };
  const TOOL_LINE = 8;

  it("full mode: a suspicious key in a tool input is reported with the line of its tool call", () => {
    const value = randomish(16, 41);
    const p = prepare(transcript({ command: "ls", [mediumKey(value)]: 1 }));
    expect(p.report.suspicious).toHaveLength(1);
    expect(p.report.suspicious[0]).toMatchObject({ location: "turn 3 · Bash · input (object key)", source: { hits: [{ line: TOOL_LINE }], total: 1 } });
    expect(formatReport(p.report)).toContain("turn 3 · Bash · input (object key) · line 8");
  });

  it("full mode: a blocked key reports its line, in the report and the browse review", () => {
    const secret = fake.github();
    const p = prepare(transcript({ command: "ls", [secret]: 1 }));
    expect(p.report.blocked).toBe(true);
    expect(p.report.rescan[0]).toMatchObject({ rule: "github-v2", location: "turn 3 · Bash · input (object key)", source: { hits: [{ line: TOOL_LINE }], total: 1 } });
    expect(formatReport(p.report)).toContain(`✗ github-v2 (${secret.length} chars) @ turn 3 · Bash · input (object key) · line 8`);
    expect(summarizeShare(p).issues).toEqual([{ rule: "github-v2", length: secret.length, location: "turn 3 · Bash · input (object key)", lines: "line 8" }]);
  });

  it("a known secret that reached the payload is located too (it had no location before)", () => {
    const value = fake.envValue();
    const known = [knownSecret(value, "MY_SERVICE_KEY", "env")];
    const p = prepare(transcript({ command: "ls", [value]: 1 }), "full", { knownSecrets: known });
    expect(p.report.blocked).toBe(true);
    expect(p.report.rescan).toEqual([{ rule: "known-secret:MY_SERVICE_KEY", length: value.length, location: "turn 3 · Bash · input (object key)", source: { hits: [{ line: TOOL_LINE }], total: 1 } }]);
    for (const text of surfaces(p)) expect(text).not.toContain(value.slice(0, 12));
  });

  it("counts blank lines, so the number is the one an editor shows", () => {
    const p = prepare(transcript({ command: "ls", [mediumKey(randomish(16, 41))]: 1 }, { blankBefore: 3 }));
    expect(p.report.suspicious[0]?.source).toEqual({ hits: [{ line: TOOL_LINE + 3 }], total: 1 });
  });

  it("lists every line a value is on, first ones only, in file order", () => {
    const key = mediumKey(randomish(16, 41));
    const t = new ClaudeTranscript("aaaaaaaa-0000-0000-0000-000000000000", "/home/tester/work/demo").user("go");
    for (let i = 0; i < 7; i++) t.assistant(`m${i}`, [{ type: "tool_use", id: `b${i}`, name: "Bash", input: { [key]: i } }], ccUsage(1, 1)).toolResult(`b${i}`, "ok");
    const { suspicious } = prepare(t.toJsonl()).report;
    expect(suspicious).toHaveLength(1); // deduplicated by value
    expect(suspicious[0]).toMatchObject({ occurrences: 7, source: { hits: [{ line: 2 }, { line: 4 }, { line: 6 }, { line: 8 }, { line: 10 }], total: 7 } });
    expect(formatReport(prepare(t.toJsonl()).report)).toContain("lines 2, 4, 6, 8, 10 (+2 more)");
  });

  it("names the subagent file a value is also in, by a report-safe name", () => {
    const key = mediumKey(randomish(16, 41));
    const sub = `${JSON.stringify({ type: "user", isSidechain: true })}\n${JSON.stringify({ type: "assistant", isSidechain: true, message: { content: [{ type: "tool_use", name: "Bash", input: { [key]: 1 } }] } })}\n`;
    const p = prepare(transcript({ command: "ls", [key]: 1 }), "full", { subagentFiles: [{ fileName: "agent-a1.jsonl", raw: sub }] });
    expect(p.report.suspicious[0]?.source).toEqual({ hits: [{ line: TOOL_LINE }, { file: "agent-a1.jsonl", line: 2 }], total: 2 });
    expect(formatReport(p.report)).toContain(`line ${TOOL_LINE}; agent-a1.jsonl line 2`);
  });

  /**
   * A transcript line whose `type` is a secret is dropped, and the type is kept as a key of `redaction.dropped`, which
   * every mode publishes. That makes a finding that survives every mode, which is what the matrix needs; the mode only
   * changes the turns, so the line must not depend on it. If those keys are ever sanitized, plant the value somewhere
   * else that every mode keeps.
   */
  const dropped = (type: string) =>
    new ClaudeTranscript("aaaaaaaa-0000-0000-0000-000000000000", "/home/tester/work/demo")
      .user("first")
      .assistant("m1", [{ type: "text", text: "one" }], ccUsage(1, 1))
      .user("second")
      .attachment({ type })
      .assistant("m2", [{ type: "tool_use", id: "b1", name: "Bash", input: { command: "ls" } }], ccUsage(1, 1))
      .toolResult("b1", "ok")
      .assistant("m3", [{ type: "text", text: "done" }], ccUsage(1, 1))
      .toJsonl();
  const MODES: ShareMode[] = ["full", "brief", "minimal", "prompts"];

  for (const mode of MODES) {
    it(`${mode} mode: a blocked and a suspicious finding both carry the line`, () => {
      const secret = fake.github();
      const blocked = prepare(dropped(secret), mode);
      expect(blocked.report.rescan).toEqual([{ rule: "github-v2", length: secret.length, location: "session · redaction.dropped (object key)", source: { hits: [{ line: 4 }], total: 1 } }]);
      const value = randomish(16, 41);
      const suspicious = prepare(dropped(mediumKey(value)), mode);
      expect(suspicious.report.suspicious).toEqual([{ rule: "secret-assignment", length: value.length, location: "session · redaction.dropped (object key)", occurrences: 1, source: { hits: [{ line: 4 }], total: 1 } }]);
    });
  }
});

describe("pi", () => {
  /** header (line 1), user, assistant, user, [planted], assistant. */
  const transcript = (type: string) => {
    const t = new PiTranscript("01a0aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee", "/home/tester/work/demo")
      .user("first")
      .assistant([{ type: "text", text: "one" }], piUsage(5, 5))
      .user("second");
    t.entry(type, {});
    return t.assistant([{ type: "text", text: "done" }], piUsage(5, 5)).toJsonl();
  };

  for (const mode of ["full", "brief", "minimal"] as const) {
    it(`${mode} mode: a blocked and a suspicious finding both carry the line`, () => {
      const secret = fake.aws();
      const blocked = prepare(transcript(secret), mode);
      expect(blocked.report.rescan).toEqual([{ rule: "aws-access_keys", length: secret.length, location: "session · redaction.dropped (object key)", source: { hits: [{ line: 5 }], total: 1 } }]);
      const value = randomish(16, 41);
      const suspicious = prepare(transcript(mediumKey(value)), mode);
      expect(suspicious.report.suspicious).toEqual([{ rule: "secret-assignment", length: value.length, location: "session · redaction.dropped (object key)", occurrences: 1, source: { hits: [{ line: 5 }], total: 1 } }]);
    });
  }

  it("a tool-call key in the middle of a branched session points at the line in the file, not at the branch", () => {
    const key = mediumKey(randomish(16, 41));
    const t = new PiTranscript("01a0aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee", "/home/tester/work/demo").user("first");
    const fork = t.lastId!;
    t.assistant([{ type: "text", text: "abandoned" }], piUsage(5, 5)); // line 3, off the exported branch
    t.branchFrom(fork).assistant([{ type: "toolCall", id: "c1", name: "bash", arguments: { [key]: 1 } }], piUsage(5, 5)).toolResult("c1", "bash", "ok");
    const p = prepare(t.toJsonl());
    expect(p.report.suspicious[0]).toMatchObject({ location: "turn 1 · bash · input (object key)", source: { hits: [{ line: 4 }], total: 1 } });
  });
});

describe("what stays out of the payload and the report", () => {
  const withBlanks = (raw: string, n: number) => `${"\n".repeat(n)}${raw}`;
  const raw = new ClaudeTranscript("aaaaaaaa-0000-0000-0000-000000000000", "/home/tester/work/demo")
    .user("first")
    .assistant("m1", [{ type: "tool_use", id: "b1", name: "Bash", input: { command: "ls", [mediumKey(randomish(16, 41))]: 1, [fake.github()]: 2 } }], ccUsage(1, 1))
    .toolResult("b1", "ok")
    .toJsonl();

  for (const mode of ["full", "brief", "minimal", "prompts"] as const) {
    it(`${mode}: the uploaded bytes do not depend on where the finding is in the file`, () => {
      const a = prepare(raw, mode);
      const b = prepare(withBlanks(raw, 40), mode);
      expect(b.json).toBe(a.json);
      // No line information anywhere in the payload: not as a key, not as a value.
      expect(a.json).not.toMatch(/"(hits|lines)"/);
      expect(JSON.parse(a.json)).not.toHaveProperty("source.hits");
    });
  }

  it("the line moves with the file while the report is otherwise the same", () => {
    const a = prepare(raw);
    const b = prepare(withBlanks(raw, 40));
    expect(a.report.rescan[0]?.source?.hits).toEqual([{ line: 2 }]);
    expect(b.report.rescan[0]?.source?.hits).toEqual([{ line: 42 }]);
  });

  it("no surface prints a character of the value next to its line", () => {
    const value = randomish(16, 41);
    const secret = fake.github();
    const p = prepare(
      new ClaudeTranscript("aaaaaaaa-0000-0000-0000-000000000000", "/home/tester/work/demo")
        .user("first")
        .assistant("m1", [{ type: "tool_use", id: "b1", name: "Bash", input: { command: "ls", [mediumKey(value)]: 1, [secret]: 2 } }], ccUsage(1, 1))
        .toJsonl(),
    );
    expect(p.report.suspicious).toHaveLength(1);
    expect(p.report.rescan).toHaveLength(1);
    for (const text of surfaces(p)) {
      expect(text).toContain("2"); // the line is there
      for (const s of [value, secret]) for (let i = 0; i + 6 <= s.length; i++) expect(text).not.toContain(s.slice(i, i + 6));
    }
  });
});
