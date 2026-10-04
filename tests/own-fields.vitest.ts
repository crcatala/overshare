/**
 * The Redactor exempts only the identifier fields of our schema (`OWN_*_FIELDS`), by place in the schema, not by key name.
 * Free-form content is walked with no key skipped: a tool input that has an `id`, `kind`, `event` or `action`
 * property gets redacted like any other. Everything here runs the real pipeline with planted fake secrets.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseSession } from "../src/harnesses/index.js";
import { summarizeShare } from "../src/browse/job.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { projectSession } from "../src/modes.js";
import { prepareShare, type PrepareOptions } from "../src/pipeline.js";
import { OWN_SESSION_FIELDS, OWN_STEP_FIELDS, OWN_TURN_FIELDS, Redactor, redactSession } from "../src/redact/index.js";
import { knownSecret } from "../src/redact/known-values.js";
import { rescanPayload } from "../src/redact/rescan.js";
import { formatReport } from "../src/report.js";
import { PI_INPUT_PROVENANCE_TYPE, SHARE_MODES, type HarnessName } from "../src/schema.js";
import { ClaudeTranscript, PiTranscript, ccUsage, fake, randomish } from "./helpers.js";

const machine = { homeDir: "/home/tester", username: "tester", hostname: "box" };
/** A machine none of the fixtures' paths or names belong to, so a secret-free session has nothing to rewrite. */
const elsewhere = { homeDir: "/home/other", username: "other-user", hostname: "other-box" };
const HARNESSES: HarnessName[] = ["claude-code", "pi"];

/** One transcript per harness whose single tool call has `input` as its arguments. */
function transcript(harness: HarnessName, input: Record<string, unknown>): string {
  if (harness === "claude-code") {
    return new ClaudeTranscript("aaaaaaaa-0000-0000-0000-000000000000", "/home/tester/work/demo")
      .user("run it")
      .assistant("m1", [{ type: "tool_use", id: "b1", name: "Bash", input }], ccUsage(1, 1))
      .toolResult("b1", "ok")
      .assistant("m2", [{ type: "text", text: "done" }], ccUsage(1, 1))
      .toJsonl();
  }
  // Authored-input provenance, so prompts mode is available for pi too.
  const t = new PiTranscript();
  const timestamp = 1_700_000_000_000;
  t.entry("custom", { customType: PI_INPUT_PROVENANCE_TYPE, data: { version: 1, text: "run it", source: "interactive", messageTimestamp: timestamp, messageHash: createHash("sha256").update("run it").digest("hex") } });
  t.entry("message", { message: { role: "user", content: [{ type: "text", text: "run it" }], timestamp } });
  return t
    .assistant([{ type: "toolCall", id: "c1", name: "bash", arguments: input }])
    .toolResult("c1", "bash", "ok")
    .assistant([{ type: "text", text: "done" }], undefined, { stopReason: "stop" })
    .toJsonl();
}

const prepare = (raw: string, mode: PrepareOptions["mode"] = "full", extra: Partial<PrepareOptions> = {}) =>
  prepareShare(raw, { mode, config: DEFAULT_CONFIG, machine, knownSecrets: [], ...extra });

/** A distinct fake GitHub token per call site (same shape as `fake.github()`, different bytes). */
const ghp = (seed: number) => ["gh", "p_", randomish(36, seed)].join("");

/**
 * The same kind of value under every skip-named key the old Redactor ignored, at depth 1, 2 and 3 and inside
 * arrays. `values[i]` goes to the i-th place so a miss names the place.
 */
function planted(values: string[]): { input: Record<string, unknown>; places: string[] } {
  const v = (i: number) => values[i % values.length]!;
  return {
    input: {
      command: "run",
      id: v(0),
      kind: v(1),
      event: v(2),
      action: v(3),
      responseId: v(4),
      sessionId: v(5),
      meta: { id: v(6), nested: { action: v(7), deeper: { kind: v(8) } } },
      list: [{ event: v(9) }, { sessionId: v(10) }, [{ responseId: v(11) }]],
      ids: [v(12)],
    },
    places: ["id", "kind", "event", "action", "responseId", "sessionId", "meta.id", "meta.nested.action", "meta.nested.deeper.kind", "list[0].event", "list[1].sessionId", "list[2][0].responseId", "ids[0]"],
  };
}
const PLACES = 13;

/** Windows of `secret` (length > 2) in `output` that the secret-free `baseline` does not have. */
function leaked(output: string, secret: string, baseline: string, size = 3): string[] {
  const out: string[] = [];
  for (let i = 0; i + size <= secret.length; i++) {
    const w = secret.slice(i, i + size);
    if (output.includes(w) && !baseline.includes(w)) out.push(w);
  }
  return out;
}

describe("free-form content is redacted whatever its keys are called", () => {
  for (const harness of HARNESSES) {
    describe(harness, () => {
      const secrets = Array.from({ length: PLACES }, (_, i) => ghp(100 + i));
      const { input, places } = planted(secrets);
      const raw = transcript(harness, input);

      it("guards the fixture: the planted input reaches the tool step as written", () => {
        const step = parseSession(raw, harness).session.turns[0]!.steps.find((s) => s.kind === "tool");
        expect(step && "input" in step ? step.input : undefined).toEqual(input);
      });

      for (const mode of SHARE_MODES) {
        it(`${mode}: no planted secret reaches the payload; redaction (not the re-scan block) caught them`, () => {
          const prepared = prepare(raw, mode);
          secrets.forEach((s, i) => expect(prepared.json, places[i]).not.toContain(s));
          expect(prepared.report.blocked).toBe(false);
          expect(prepared.report.rescan).toEqual([]);
          if (mode === "full") {
            // The input is only in full mode; one finding per place, each located at the tool step.
            expect(prepared.report.findings.filter((f) => f.rule.startsWith("github"))).toHaveLength(PLACES);
            expect(prepared.json.match(/\[REDACTED:github/g)).toHaveLength(PLACES);
          }
        });
      }
    });
  }

  it("a medium-confidence secret under such a key is redacted, not left for a confirmation", () => {
    for (const harness of HARNESSES) {
      const values = Array.from({ length: PLACES }, (_, i) => `db_password=${randomish(16, 200 + i)}`);
      const { input, places } = planted(values);
      const prepared = prepare(transcript(harness, input));
      values.forEach((v, i) => expect(prepared.json, `${harness} ${places[i]}`).not.toContain(v.split("=")[1]!));
      expect(prepared.report.suspicious, harness).toEqual([]);
      expect(prepared.report.blocked, harness).toBe(false);
      expect(prepared.report.findings.filter((f) => f.rule.startsWith("secret-assignment")), harness).toHaveLength(PLACES);
    }
  });

  it("a secret with no recognizable format is redacted when it is a known value", () => {
    for (const harness of HARNESSES) {
      const value = fake.envValue();
      const { input } = planted([value]);
      const known = [knownSecret(value, "DB_PASS", "env")];
      const prepared = prepare(transcript(harness, input), "full", { knownSecrets: known });
      expect(prepared.json, harness).not.toContain(value);
      expect(prepared.json.match(/\[REDACTED:DB_PASS\]/g), harness).toHaveLength(PLACES);
      expect(prepared.report.rescan, harness).toEqual([]);
      // Control: the format-less value is invisible to every pattern, so only the known-value layer can have caught it.
      expect(prepare(transcript(harness, input)).json, harness).toContain(value);
    }
  });

  it("a secret under a sensitive key name inside such a field is redacted without any recognizable format", () => {
    for (const harness of HARNESSES) {
      const value = `Hunter2${randomish(10, 9)}`;
      const input = { command: "run", id: { password: value }, action: [{ api_key: value }], meta: { kind: { nested: { client_secret: value } } } };
      const prepared = prepare(transcript(harness, input));
      expect(prepared.json, harness).not.toContain(value);
      expect(prepared.json, harness).toContain("[REDACTED:password]");
      expect(prepared.report.findings.filter((f) => f.rule.startsWith("sensitive-key:")), harness).toHaveLength(3);
    }
  });

  it("the other Redactor rules apply too: home path, username and denylist under an `id`", () => {
    for (const harness of HARNESSES) {
      const config = { ...DEFAULT_CONFIG, redact: { ...DEFAULT_CONFIG.redact, denylist: ["acme-internal"] } };
      const input = { command: "run", id: "/home/tester/work/demo/x.ts", kind: ["tester"], meta: { action: "acme-internal" } };
      const prepared = prepare(transcript(harness, input), "full", { config });
      expect(prepared.report.rescan, harness).toEqual([]); // before the fix the home path here blocked the share
      expect(prepared.json, harness).not.toContain("/home/tester");
      expect(prepared.json, harness).not.toContain("acme-internal");
      expect(prepared.json, harness).toContain('"id":"~/work/demo/x.ts"');
      expect(prepared.json, harness).toContain('"kind":["[user]"]');
    }
  });
});

describe("our own identifier fields are untouched", () => {
  /** What a tool input legitimately carries under these keys: uuids, enum words, timestamps, tool-use ids. */
  const benign = {
    command: "run",
    id: "7f9c2a1e-3b4d-4e5f-8a6b-1c2d3e4f5a6b",
    kind: "file",
    event: "change",
    action: "read",
    responseId: "msg_01abcDEFghiJKLmnoPQRstu",
    sessionId: "11111111-2222-3333-4444-555555555555",
    meta: { id: "toolu_01A9bCdEfGhIjKlMnOpQrStU", timestamp: "2026-01-01T00:00:00.000Z" },
  };

  for (const harness of HARNESSES) {
    it(`${harness}: on a secret-free session redaction is a no-op, so the payload is the projected session byte for byte`, () => {
      const raw = transcript(harness, benign);
      for (const mode of SHARE_MODES) {
        const projected = projectSession(parseSession(raw, harness).session, mode);
        const redactor = new Redactor(elsewhere);
        expect(JSON.stringify(redactSession(projected, redactor)), mode).toBe(JSON.stringify(projected));
        expect(redactor.findings, mode).toEqual([]);
        const prepared = prepare(raw, mode, { machine: elsewhere });
        expect(prepared.report.findings, mode).toEqual([]);
        expect(prepared.report.clean, mode).toBe(true);
      }
    });
  }

  it("ids, timestamps, kinds and enum words on a step are copied even when they look like what the rules rewrite", () => {
    const raw = transcript("claude-code", { command: "run" });
    const full = parseSession(raw, "claude-code").session;
    const bait = "tester@acme-corp.test";
    const step = full.turns[0]!.steps.find((s) => s.kind === "tool")!;
    Object.assign(step, { id: bait, responseId: bait, timestamp: "/home/tester/ts" });
    const out = redactSession(projectSession(full, "full"), new Redactor(machine));
    expect(out.turns[0]!.steps.find((s) => s.kind === "tool")).toMatchObject({ id: bait, responseId: bait, timestamp: "/home/tester/ts" });
    // ...while the same value in a free-form field is rewritten.
    Object.assign(step, { summary: bait });
    expect(JSON.stringify(redactSession(projectSession(full, "full"), new Redactor(machine)).turns[0]!.steps)).toContain("[email]");
  });

  it("names exactly the fields the schema defines as ours", () => {
    expect([...OWN_STEP_FIELDS].sort()).toEqual(["action", "event", "id", "kind", "responseId", "timestamp"]);
    expect([...OWN_TURN_FIELDS]).toEqual(["timestamp"]);
    expect([...OWN_SESSION_FIELDS].sort()).toEqual(["endedAt", "generator.sharedAt", "responses.id", "responses.timestamp", "schema", "source.leafId", "source.sessionId", "startedAt"]);
  });
});

describe("the re-scan exempts the same fields", () => {
  const bait = () => `db_password=${randomish(16, 41)}`;
  const turn = (step: Record<string, unknown>) => JSON.stringify({ schema: "x", turns: [{ index: 0, steps: [step] }] });

  it("a medium match in an own field is not suspicious, in the same field one level down it is", () => {
    for (const key of OWN_STEP_FIELDS) {
      expect(rescanPayload(turn({ kind: "text", [key]: bait() })).suspicious, key).toEqual([]);
      expect(rescanPayload(turn({ kind: "tool", name: "Bash", input: { [key]: bait() } })).suspicious.map((i) => i.location), key).toEqual([`turn 1 · Bash · input.${key}`]);
    }
  });

  it("an own key holding an array or an object is not an identifier", () => {
    expect(rescanPayload(turn({ kind: "text", id: [bait()] })).suspicious).toHaveLength(1);
    expect(rescanPayload(turn({ kind: "text", id: { x: bait() } })).suspicious).toHaveLength(1);
  });

  it("session-level own fields are exempt by path only", () => {
    const session = (extra: Record<string, unknown>) => JSON.stringify({ schema: "x", turns: [], ...extra });
    expect(rescanPayload(session({ source: { sessionId: bait(), leafId: bait() }, responses: [{ id: bait(), timestamp: bait() }] })).suspicious).toEqual([]);
    expect(rescanPayload(session({ responses: [{ id: "r", model: bait() }] })).suspicious).toHaveLength(1);
    expect(rescanPayload(session({ stats: { id: bait() } })).suspicious).toHaveLength(1);
    expect(rescanPayload(session({ project: { name: bait() } })).suspicious).toHaveLength(1);
  });

  it("a turn's own timestamp is exempt, its other fields are not", () => {
    const raw = JSON.stringify({ schema: "x", turns: [{ index: 0, timestamp: bait(), steps: [] }] });
    expect(rescanPayload(raw).suspicious).toEqual([]);
    const other = JSON.stringify({ schema: "x", turns: [{ index: 0, activity: { id: bait() }, steps: [] }] });
    expect(rescanPayload(other).suspicious).toHaveLength(1);
  });
});

describe("planted secrets under skip-named keys never reach a report surface", () => {
  const secret = ghp(300);
  const medium = `db_password=${randomish(16, 301)}`;
  const mediumValue = medium.split("=")[1]!;
  const input = (s: string, m: string) => ({ command: "run", id: s, meta: { action: [{ kind: m }] } });

  for (const harness of HARNESSES) {
    it(`${harness}: human report, --json and the browse summary have no fragment of either value`, () => {
      const prepared = prepare(transcript(harness, input(secret, medium)));
      const baselinePrepared = prepare(transcript(harness, input("plain", "plain")));
      const surfaces = (p: ReturnType<typeof prepare>) => ({
        human: formatReport(p.report, { maxFindings: Infinity }),
        json: JSON.stringify({ path: "x.jsonl", ...p.report }, null, 2),
        browse: JSON.stringify(summarizeShare(p)),
      });
      expect(prepared.report.findings.length).toBeGreaterThanOrEqual(2);
      const baseline = Object.values(surfaces(baselinePrepared)).join("\n");
      for (const [name, text] of Object.entries(surfaces(prepared))) {
        expect(leaked(text, secret, baseline), name).toEqual([]);
        expect(leaked(text, mediumValue, baseline), name).toEqual([]);
        expect(text, name).not.toContain("db_password");
      }
      expect(prepared.json).not.toContain(secret);
      expect(prepared.json).not.toContain(mediumValue);
    });
  }

  it("the CLI (stdout, stderr, --json) has no fragment either, including when publish refuses", { timeout: 30_000 }, () => {
    const dir = mkdtempSync(join(tmpdir(), "as-own-"));
    const home = mkdtempSync(join(tmpdir(), "as-own-home-"));
    const cli = (raw: string, ...args: string[]) => {
      const file = join(dir, "s.jsonl");
      writeFileSync(file, raw);
      const r = spawnSync(process.execPath, ["--import", "tsx", join(import.meta.dirname, "..", "src", "cli.ts"), ...args.map((a) => (a === "FILE" ? file : a))], {
        encoding: "utf8",
        env: { PATH: "/nonexistent", HOME: home, XDG_CONFIG_HOME: join(home, ".config"), NO_COLOR: "1", PI_CODING_AGENT_DIR: join(home, "pi"), CLAUDE_CONFIG_DIR: join(home, "claude") },
        input: "",
      });
      return { status: r.status, text: [r.stdout, r.stderr].join("\n") };
    };
    const planted = transcript("claude-code", input(secret, medium));
    const clean = transcript("claude-code", input("plain", "plain"));
    const runs = [["report", "FILE", "--mode", "full"], ["report", "FILE", "--mode", "full", "--json"], ["publish", "FILE", "--mode", "full", "--yes"]];
    const baseline = runs.map((a) => cli(clean, ...a).text).join("\n");
    for (const args of runs) {
      const out = cli(planted, ...args);
      // Redacted, so nothing is blocked; the secrets were found, so a bare --yes asks for --allow-findings (exit 2).
      expect(out.status, args.join(" ")).toBe(2);
      expect(leaked(out.text, secret, baseline), args.join(" ")).toEqual([]);
      expect(leaked(out.text, mediumValue, baseline), args.join(" ")).toEqual([]);
    }
  });
});
