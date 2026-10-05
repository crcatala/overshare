/**
 * The confirmation tier: a medium-confidence match that is still in the outgoing bytes is reported (rule, length,
 * location; never a character of the value) and publishing needs an explicit confirmation. Everything here runs
 * the real pipeline / report / browse source with planted fake secrets: nothing can leak by mock.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { summarizeShare } from "../src/browse/job.js";
import { createSource } from "../src/browse/source.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { prepareShare, type PrepareOptions } from "../src/pipeline.js";
import { findSecretPatterns } from "../src/redact/patterns.js";
import { rescanPayload } from "../src/redact/rescan.js";
import { formatReport } from "../src/report.js";
import { buildIndex } from "../src/sessions/index.js";
import type { Publisher, PublishPayload } from "../src/publish/types.js";
import { ClaudeTranscript, ccUsage, fake, randomish } from "./helpers.js";

const machine = { homeDir: "/home/tester", username: "tester", hostname: "box" };

/** `db_password=<fake>` as an object key: the Redactor never walks keys, so it stays in the payload at medium confidence. */
const plantedValue = () => randomish(16, 41);
const plantedKey = (value = plantedValue()) => `db_password=${value}`;

/** Three turns; the planted key sits in the third, inside a Bash tool call's input. */
const transcript = (input: Record<string, unknown> = { command: "ls" }) =>
  new ClaudeTranscript("aaaaaaaa-0000-0000-0000-000000000000", "/home/tester/work/demo")
    .user("first")
    .assistant("m1", [{ type: "text", text: "one" }], ccUsage(1, 1))
    .user("second")
    .assistant("m2", [{ type: "text", text: "two" }], ccUsage(1, 1))
    .user("third")
    .assistant("m3", [{ type: "tool_use", id: "b1", name: "Bash", input }], ccUsage(1, 1))
    .toolResult("b1", "ok")
    .assistant("m4", [{ type: "text", text: "done" }], ccUsage(1, 1))
    .toJsonl();

const prepare = (raw: string, extra: Partial<PrepareOptions> = {}) =>
  prepareShare(raw, { mode: "full", config: DEFAULT_CONFIG, machine, knownSecrets: [], ...extra });

/** Windows of `secret` (length > 2) in `output`. The secret-free baseline keeps rule names from false-failing. */
function leaked(output: string, secret: string, baseline: string, size = 3): string[] {
  const out: string[] = [];
  for (let i = 0; i + size <= secret.length; i++) {
    const w = secret.slice(i, i + size);
    if (output.includes(w) && !baseline.includes(w)) out.push(w);
  }
  return out;
}

describe("suspicious tier", () => {
  it("the planted key really is a medium-confidence match (guards the fixture)", () => {
    expect(findSecretPatterns(plantedKey()).map((m) => m.confidence)).toEqual(["medium"]);
  });

  it("a medium match left in the payload is reported with its location, and does not block", () => {
    const value = plantedValue();
    const prepared = prepare(transcript({ command: "ls", [plantedKey(value)]: 1 }));
    expect(prepared.report.rescan).toEqual([]);
    expect(prepared.report.blocked).toBe(false);
    expect(prepared.report.clean).toBe(false);
    expect(prepared.report.suspicious).toEqual([{ rule: "secret-assignment", length: value.length, location: "turn 3 · Bash · input (object key)", occurrences: 1, source: { hits: [{ line: 6 }], total: 1 } }]);
  });

  it("points at the right turn in a multi-message session", () => {
    const early = prepare(
      new ClaudeTranscript("aaaaaaaa-0000-0000-0000-000000000000", "/home/tester/work/demo")
        .user(`first ${plantedKey()}`)
        .assistant("m1", [{ type: "text", text: "one" }], ccUsage(1, 1))
        .user("second")
        .assistant("m2", [{ type: "tool_use", id: "b1", name: "Read", input: { [plantedKey(randomish(14, 43))]: 1 } }], ccUsage(1, 1))
        .toolResult("b1", "ok")
        .toJsonl(),
    );
    // The prompt text is redacted by the Redactor; only the key in turn 2 is left.
    expect(early.report.suspicious.map((i) => i.location)).toEqual(["turn 2 · Read · input (object key)"]);
  });

  it("counts a value that appears in several places once, with its first location", () => {
    const key = plantedKey();
    const raw = new ClaudeTranscript("aaaaaaaa-0000-0000-0000-000000000000", "/home/tester/work/demo")
      .user("go")
      .assistant("m1", [{ type: "tool_use", id: "b1", name: "Bash", input: { [key]: 1 } }], ccUsage(1, 1))
      .toolResult("b1", "ok")
      .assistant("m2", [{ type: "tool_use", id: "b2", name: "Bash", input: { [key]: 2 } }], ccUsage(1, 1))
      .toolResult("b2", "ok")
      .toJsonl();
    const { suspicious } = prepare(raw).report;
    expect(suspicious).toHaveLength(1);
    expect(suspicious[0]).toMatchObject({ location: "turn 1 · Bash · input (object key)", occurrences: 2 });
  });

  it("a reviewed value that is allowlisted no longer shows up", () => {
    const value = plantedValue();
    const raw = transcript({ [plantedKey(value)]: 1 });
    expect(prepare(raw).report.suspicious).toHaveLength(1);
    const config = { ...DEFAULT_CONFIG, redact: { ...DEFAULT_CONFIG.redact, allowlist: [value] } };
    const after = prepare(raw, { config });
    expect(after.report.suspicious).toEqual([]);
    expect(after.report.clean).toBe(true);
  });

  it("high-confidence matches still block (and are not also listed as suspicious), now with a location", () => {
    const secret = fake.github();
    const prepared = prepare(transcript({ command: "ls", [secret]: 1 }));
    expect(prepared.report.blocked).toBe(true);
    expect(prepared.report.rescan[0]).toMatchObject({ rule: "github-v2", location: "turn 3 · Bash · input (object key)" });
    expect(prepared.report.suspicious).toEqual([]);
  });

  it("a redacted medium match is not suspicious: the Redactor replaced it", () => {
    const prepared = prepare(transcript({ command: `export ${plantedKey()}` }));
    expect(prepared.report.counts["secret-pattern"]).toBeGreaterThan(0);
    expect(prepared.report.suspicious).toEqual([]);
  });

  describe("rescanPayload", () => {
    const payload = (turn: unknown) => JSON.stringify({ schema: "x", turns: [turn] });

    it("ignores identifier fields the Redactor skips on purpose, but not what sits next to them", () => {
      const value = plantedValue();
      const ids = payload({ index: 0, steps: [{ kind: "text", id: plantedKey(value), text: "hi" }] });
      expect(rescanPayload(ids).suspicious).toEqual([]);
      const key = payload({ index: 0, steps: [{ kind: "text", id: "s1", text: "hi", [plantedKey(value)]: 1 }] });
      expect(rescanPayload(key).suspicious).toHaveLength(1);
    });

    it("session-level schema fields (response ids) are identifiers at any depth", () => {
      const raw = JSON.stringify({ schema: "x", responses: [{ id: plantedKey(), model: "m" }], turns: [] });
      expect(rescanPayload(raw).suspicious).toEqual([]);
    });

    it("an `id` inside a tool input is content, not an identifier field: the Redactor skips it, so the re-scan must not", () => {
      const nested = payload({ index: 0, steps: [{ kind: "tool", name: "Bash", id: "t1", input: { id: plantedKey() } }] });
      expect(rescanPayload(nested).suspicious.map((i) => i.location)).toEqual(["turn 1 · Bash · input.id"]);
    });

    it("names data-derived path segments only when they are plain identifiers", () => {
      const value = plantedValue();
      const weirdKey = fake.github();
      const raw = payload({ index: 0, steps: [{ kind: "tool", name: "Bash", input: { [weirdKey]: { [plantedKey(value)]: 1 } } }] });
      const { issues, suspicious } = rescanPayload(raw);
      expect(issues[0]!.location).toBe("turn 1 · Bash · input (object key)");
      expect(suspicious[0]!.location).toBe("turn 1 · Bash · input.key (object key)");
      expect(JSON.stringify({ issues, suspicious })).not.toContain(weirdKey.slice(4, 12));
    });

    it("falls back to a generic location for a payload that is not a session", () => {
      const { suspicious } = rescanPayload(JSON.stringify({ a: { [plantedKey()]: 1 } }));
      expect(suspicious.map((i) => i.location)).toEqual(["payload · a (object key)"]);
    });
  });
});

describe("suspicious items carry no secret content", () => {
  it("none of the report surfaces holds a fragment of the value", () => {
    const value = plantedValue();
    const prepared = prepare(transcript({ command: "ls", [plantedKey(value)]: 1 }));
    expect(prepared.report.suspicious).toHaveLength(1);
    const surfaces = (p: ReturnType<typeof prepare>) => ({
      human: formatReport(p.report, { maxFindings: Infinity, transcriptPath: "/home/tester/s.jsonl" }),
      json: JSON.stringify({ path: "x.jsonl", ...p.report }, null, 2),
      browse: JSON.stringify(summarizeShare(p)),
    });
    const baseline = Object.values(surfaces(prepare(transcript()))).join("\n");
    for (const [name, text] of Object.entries(surfaces(prepared))) {
      expect(leaked(text, value, baseline), name).toEqual([]);
      expect(text, name).not.toContain("db_password=");
    }
  });
});

describe("formatReport", () => {
  it("lists suspicious values, where to look, and asks for confirmation instead of saying CLEAN", () => {
    const prepared = prepare(transcript({ command: "ls", [plantedKey()]: 1 }));
    const text = formatReport(prepared.report, { transcriptPath: "/home/tester/s.jsonl" });
    expect(text).toContain("Suspicious: 1 value could not be redacted");
    expect(text).toContain("secret-assignment (16 chars) @ turn 3 · Bash · input (object key)");
    expect(text).toContain("/home/tester/s.jsonl");
    expect(text).toContain("redact.allowlist");
    expect(text).toContain("Status: NEEDS CONFIRMATION");
    expect(text).not.toContain("Status: CLEAN");
  });

  it("is unchanged for a clean session", () => {
    expect(formatReport(prepare(transcript()).report)).toContain("Status: CLEAN");
    expect(formatReport(prepare(transcript()).report)).not.toContain("Suspicious");
  });

  it("blocked wins over suspicious", () => {
    const text = formatReport(prepare(transcript({ command: "ls", [fake.github()]: 1, [plantedKey()]: 1 })).report);
    expect(text).toContain("Status: BLOCKED");
  });
});

describe("cli", { timeout: 30_000 }, () => {
  const root = join(import.meta.dirname, "..");
  const cli = (args: string[]) => {
    const home = mkdtempSync(join(tmpdir(), "as-susp-home-"));
    return spawnSync(process.execPath, ["--import", "tsx", join(root, "src", "cli.ts"), ...args], {
      encoding: "utf8",
      cwd: root,
      // No real credentials/config, and no gh: a publish that gets past the gates fails at the publisher.
      env: { PATH: "/nonexistent", HOME: home, XDG_CONFIG_HOME: join(home, ".config"), NO_COLOR: "1", PI_CODING_AGENT_DIR: join(home, "pi"), CLAUDE_CONFIG_DIR: join(home, "claude") },
      input: "",
    });
  };
  const session = (input: Record<string, unknown>) => {
    const file = join(mkdtempSync(join(tmpdir(), "as-susp-")), "s.jsonl");
    writeFileSync(file, transcript(input));
    return file;
  };

  it("report exits 2 and names the transcript path and location; --json has no value characters", () => {
    const value = plantedValue();
    const file = session({ command: "ls", [plantedKey(value)]: 1 });
    const human = cli(["report", file, "--mode", "full"]);
    expect(human.status).toBe(2);
    expect(human.stdout).toContain("Status: NEEDS CONFIRMATION");
    expect(human.stdout).toContain(file);
    expect(human.stdout).toContain("turn 3 · Bash · input (object key)");
    const json = cli(["report", file, "--mode", "full", "--json"]);
    expect(json.status).toBe(2);
    expect(JSON.parse(json.stdout).suspicious).toHaveLength(1);
    for (const out of [human.stdout, human.stderr, json.stdout, json.stderr]) expect(leaked(out, value, "")).toEqual([]);
  });

  it("publish --yes alone refuses with exit 2 and points at the transcript and locations", () => {
    const value = plantedValue();
    const file = session({ command: "ls", [plantedKey(value)]: 1 });
    const r = cli(["publish", file, "--mode", "full", "--yes"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("--yes does not cover suspicious values");
    expect(r.stderr).toContain(file);
    expect(r.stderr).toContain("turn 3 · Bash");
    expect(leaked(r.stdout + r.stderr, value, "")).toEqual([]);
  });

  it("--allow-findings does not cover suspicious values", () => {
    const r = cli(["publish", session({ command: "ls", [plantedKey()]: 1 }), "--mode", "full", "--yes", "--allow-findings"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("--yes does not cover suspicious values");
  });

  it("--yes --allow-suspicious gets past the gate (and then fails at the unavailable publisher, not at the gate)", () => {
    const r = cli(["publish", session({ command: "ls", [plantedKey()]: 1 }), "--mode", "full", "--yes", "--allow-suspicious"]);
    expect(r.stderr).not.toContain("--yes does not cover suspicious values");
    expect(r.status).not.toBe(2);
  });

  it("a high-confidence match still exits 3", () => {
    const r = cli(["publish", session({ command: "ls", [fake.github()]: 1 }), "--mode", "full", "--yes", "--allow-suspicious", "--allow-findings"]);
    expect(r.status).toBe(3);
  });

  it("a clean session is not affected by the new gate", () => {
    const r = cli(["publish", session({ command: "ls" }), "--mode", "full", "--yes"]);
    expect(r.stderr).not.toContain("--yes does not cover suspicious values");
    expect(r.stderr).not.toContain("--yes only applies");
  });
});

describe("browse source", () => {
  let dir: string;
  const saved = { ...process.env };
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "browse-susp-"));
    process.env.OVERSHARE_SHARES = join(dir, "state", "shares.json");
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  function recordingPublisher(): Publisher & { payloads: PublishPayload[] } {
    const payloads: PublishPayload[] = [];
    return {
      name: "fake",
      payloads,
      async publish(p) {
        payloads.push(p);
        return { id: "abc123", url: "https://gist.example/abc123", viewerUrl: "https://viewer.example/#abc123" };
      },
      async delete() {},
    };
  }

  function indexed(value: string) {
    const projects = join(dir, "claude");
    mkdirSync(join(projects, "-home-me-work-app"), { recursive: true });
    writeFileSync(join(projects, "-home-me-work-app", "sess-1.jsonl"), transcript({ command: "ls", [plantedKey(value)]: 1 }));
    return buildIndex({ roots: { "claude-code": projects, pi: join(dir, "pi") }, cachePath: join(dir, "index.json") });
  }

  it("review lists the suspicious item without the value, and publish refuses until it is confirmed", async () => {
    const value = plantedValue();
    const sessions = indexed(value);
    const publisher = recordingPublisher();
    const source = createSource({ config: DEFAULT_CONFIG, sessions, publisher: () => publisher });
    const review = await source.review(sessions[0]!, "full", "gist", new AbortController().signal);
    expect(review.blocked).toBe(false);
    expect(review.suspicious).toEqual([{ rule: "secret-assignment", length: value.length, location: "turn 3 · Bash · input (object key)", occurrences: 1, lines: "line 6" }]);
    expect(leaked(JSON.stringify(review), value, "")).toEqual([]);

    await expect(source.publish(sessions[0]!, "full", { target: "gist", reviewId: review.id })).rejects.toThrow(/suspicious values .* not confirmed/);
    expect(publisher.payloads).toEqual([]);
    // Refusing must not have thrown the reviewed payload away: confirming now uploads exactly that payload.
    await source.publish(sessions[0]!, "full", { target: "gist", reviewId: review.id, suspiciousConfirmed: true });
    expect(publisher.payloads).toHaveLength(1);
  });
});
