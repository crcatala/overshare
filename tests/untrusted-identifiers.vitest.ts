/**
 * Identifiers the transcript supplies (a tool call id, a response id, the session id, a model id) are data, not ours
 * (ass-1c07). Planted fake secrets sit in each of them; the real pipeline must keep them out of the uploaded bytes
 * and the report, while ordinary ids (`toolu_...`, uuids) pass through unchanged.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { summarizeShare } from "../src/browse/job.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { prepareShare, type PrepareOptions } from "../src/pipeline.js";
import { collectKnownSecrets, knownSecret } from "../src/redact/known-values.js";
import { safeKeys } from "../src/redact/labels.js";
import { Redactor } from "../src/redact/index.js";
import { formatReport } from "../src/report.js";
import type { ShareMode } from "../src/schema.js";
import { ClaudeTranscript, PiTranscript, ccUsage, fake, piUsage, randomish } from "./helpers.js";

const machine = { homeDir: "/home/tester", username: "tester", hostname: "box" };
const MODES: ShareMode[] = ["full", "brief", "minimal"];

const prepare = (raw: string, mode: ShareMode = "full", extra: Partial<PrepareOptions> = {}) =>
  prepareShare(raw, { mode, config: DEFAULT_CONFIG, machine, knownSecrets: [], ...extra });

/** Every way the report reaches a reader. */
const surfaces = (p: ReturnType<typeof prepare>): Record<string, string> => ({
  human: formatReport(p.report, { maxFindings: Infinity }),
  json: JSON.stringify(p.report),
  browse: JSON.stringify(summarizeShare(p)),
});

const claude = (ids: { call: string; response: string }) =>
  new ClaudeTranscript("aaaaaaaa-0000-0000-0000-000000000000", "/home/tester/work/demo")
    .user("run it")
    .assistant(ids.response, [{ type: "tool_use", id: ids.call, name: "Bash", input: { command: "ls" } }], ccUsage(1, 1))
    .toolResult(ids.call, "ok")
    .assistant("msg_01plain", [{ type: "text", text: "done" }], ccUsage(1, 1))
    .toJsonl();

const pi = (callId: string) =>
  new PiTranscript("01a0aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee", "/home/tester/work/demo")
    .user("run it")
    .assistant([{ type: "toolCall", id: callId, name: "bash", arguments: { command: "ls" } }], piUsage(5, 5))
    .toolResult(callId, "bash", "ok")
    .assistant([{ type: "text", text: "done" }], piUsage(5, 5))
    .toJsonl();

describe("step and response ids copied from the transcript", () => {
  for (const mode of MODES) {
    it(`Claude Code: a secret-shaped tool call id and response id are redacted in the ${mode} payload and block nothing`, () => {
      const call = fake.github();
      const response = fake.anthropic();
      const p = prepare(claude({ call, response }), mode);
      expect(p.json).not.toContain(call);
      expect(p.json).not.toContain(response);
      expect(p.json).not.toContain(call.slice(8, 30));
      expect(p.json).not.toContain(response.slice(8, 30));
      expect(p.report.blocked).toBe(false); // redacted at the source, not caught by the re-scan
      expect(p.report.counts["secret-pattern"]).toBeGreaterThanOrEqual(2);
      expect(p.report.rescan).toEqual([]);
    });
  }

  it("pi: a secret-shaped tool call id is redacted in the payload", () => {
    const call = fake.github();
    for (const mode of MODES) {
      const p = prepare(pi(call), mode);
      expect(p.json, mode).not.toContain(call);
      expect(p.report.blocked, mode).toBe(false);
    }
  });

  it("pi: a secret-shaped response id (the entry id) is redacted in the payload", () => {
    const entry = fake.aws();
    const raw = pi("call_ok").replaceAll('"e2"', `"${entry}"`);
    expect(raw).toContain(entry);
    const p = prepare(raw);
    expect(p.json).not.toContain(entry);
    expect(p.report.blocked).toBe(false);
  });

  it("a known secret used as a call id is redacted too", () => {
    const value = fake.envValue();
    const p = prepare(claude({ call: value, response: "msg_01other" }), "full", { knownSecrets: [knownSecret(value, "SVC_TOKEN", "env")] });
    expect(p.json).not.toContain(value);
    expect(p.report.blocked).toBe(false);
  });

  it("ordinary ids are untouched, in every mode", () => {
    const call = `toolu_01${randomish(22, 5)}`;
    const response = `msg_01${randomish(22, 6)}`;
    for (const mode of MODES) {
      const p = prepare(claude({ call, response }), mode);
      expect(p.report.findings, mode).toEqual([]);
      expect(p.report.rescan, mode).toEqual([]);
      expect(p.report.suspicious, mode).toEqual([]);
      if (mode === "full") {
        expect(p.json).toContain(call);
        expect(p.json).toContain(response);
      }
    }
  });

  it("identifiers go through the secret rules only: an email-shaped id is not mangled, a message is", () => {
    const r = new Redactor({ ...machine, redactEmails: true, redactUsername: true });
    const id = "ops@corp-mail.dev";
    expect(r.redactIdentifier(id)).toBe(id);
    expect(r.redactText(id)).not.toBe(id);
  });
});

describe("the report echoes no transcript-supplied identifier that fails the identifier check", () => {
  it("a secret-shaped session id appears on no report surface", () => {
    const secret = fake.github();
    const raw = new ClaudeTranscript(secret, "/home/tester/work/demo").user("hi").assistant("m1", [{ type: "text", text: "yo" }], ccUsage(1, 1)).toJsonl();
    const p = prepare(raw);
    expect(p.report.sessionId).toBe("unknown");
    for (const [name, text] of Object.entries(surfaces(p))) expect(text.includes(secret) || text.includes(secret.slice(8, 30)), name).toBe(false);
  });

  it("an ordinary session id is kept", () => {
    expect(prepare(claude({ call: "toolu_x", response: "msg_x" })).report.sessionId).toBe("aaaaaaaa-0000-0000-0000-000000000000");
  });

  it("a secret-shaped model id (the key of pi's per-model rates) appears on no report surface", () => {
    const model = fake.aws();
    const cost = { input: 0.001, output: 0.001, cacheRead: 0.0001, cacheWrite: 0, total: 0.0021 };
    const raw = new PiTranscript("01a0aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee", "/home/tester/work/demo")
      .user("go")
      .assistant([{ type: "text", text: "yo" }], { ...piUsage(100, 10, 100, 0), cost }, { model })
      .toJsonl();
    const p = prepare(raw);
    expect(Object.keys(p.report.stats.rates ?? {})).toEqual(["model-1"]);
    for (const [name, text] of Object.entries(surfaces(p))) expect(text.includes(model), name).toBe(false);
  });

  it("safeKeys keeps identifier keys and numbers the replacements", () => {
    const out = safeKeys({ "claude-opus-5-5": 1, [fake.github()]: 2, [fake.aws()]: 3, "gpt-6.1-sol": 4 }, "model");
    expect(out).toEqual({ "claude-opus-5-5": 1, "model-1": 2, "model-2": 3, "gpt-6.1-sol": 4 });
  });

  it("safeKeys never overwrites a value: a replacement skips a genuine key of the same name, in either order", () => {
    const bad = fake.github();
    expect(safeKeys({ [bad]: 1, "model-1": 2 }, "model")).toEqual({ "model-2": 1, "model-1": 2 });
    expect(safeKeys({ "model-1": 2, [bad]: 1 }, "model")).toEqual({ "model-1": 2, "model-2": 1 });
  });

  it("a project .env file named like a secret is reported as '.env', an ordinary one by name", () => {
    const dir = mkdtempSync(join(tmpdir(), "ids-env-"));
    const planted = fake.github();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `.env.${planted}`), `SVC_TOKEN=${fake.envValue()}\n`);
    writeFileSync(join(dir, ".env.local"), `OTHER_TOKEN=${fake.anthropic()}\n`);
    const { secrets } = collectKnownSecrets({ projectDir: dir, home: dir, env: {}, enabled: { env: false, credentialFiles: false, ghToken: false, projectEnv: true } });
    const sources = secrets.map((k) => k.source).sort();
    expect(sources).toEqual([".env", ".env.local"]);
    expect(sources.join("\n")).not.toContain(planted);
  });
});

describe("entry types of dropped transcript entries (ass-t3hc)", () => {
  /** Every transcript-supplied part of a `redaction.dropped` key, for a Claude Code transcript. */
  const claudeDropping = (secrets: { type: string; attachment: string; subtype: string }) =>
    new ClaudeTranscript("aaaaaaaa-0000-0000-0000-000000000000", "/home/tester/work/demo")
      .meta(secrets.type, { uuid: "meta-1", parentUuid: null }) // an entry off the exported branch is not counted, so it joins the chain
      .rewindTo("meta-1")
      .user("run it")
      .attachment({ type: secrets.attachment })
      .attachment({ type: "queued_command" })
      .system(secrets.subtype)
      .system("turn_duration")
      .assistant("msg_01plain", [{ type: "text", text: "done" }], ccUsage(1, 1))
      .toJsonl();

  const piDropping = (secrets: { type: string; custom: string; customMessage: string }) => {
    const t = new PiTranscript("01a0aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee", "/home/tester/work/demo").user("run it");
    t.entry(secrets.type, {});
    t.entry("custom", { customType: secrets.custom });
    t.entry("custom_message", { customType: secrets.customMessage, content: "x" });
    t.entry("label", { customType: "bookmark" });
    return t.assistant([{ type: "text", text: "done" }], piUsage(5, 5)).toJsonl();
  };

  for (const mode of [...MODES, "prompts" as const]) {
    it(`Claude Code: a secret-shaped type, attachment type or subtype never reaches the ${mode} payload or the report`, () => {
      const secrets = { type: fake.github(), attachment: fake.anthropic(), subtype: `db_password=${randomish(16, 41)}` };
      const p = prepare(claudeDropping(secrets), mode);
      for (const secret of Object.values(secrets)) {
        expect(p.json).not.toContain(secret);
        expect(p.json).not.toContain(secret.slice(8, 30));
        for (const [name, text] of Object.entries(surfaces(p))) expect(text, name).not.toContain(secret.slice(8, 30));
      }
      // Replaced before the re-scan, so there is nothing for it to block or flag.
      expect(p.report.blocked).toBe(false);
      expect(p.report.rescan).toEqual([]);
      expect(p.report.suspicious).toEqual([]);
      expect(p.report.dropped).toEqual({ "entry-1": 1, "entry-2": 1, "entry-3": 1, "attachment:queued_command": 1, "system:turn_duration": 1 });
      expect(p.session.redaction?.dropped).toEqual(p.report.dropped);
    });

    if (mode === "prompts") continue;
    it(`pi: a secret-shaped type or custom type never reaches the ${mode} payload or the report`, () => {
      const secrets = { type: fake.aws(), custom: fake.github(), customMessage: `db_password=${randomish(16, 41)}` };
      const p = prepare(piDropping(secrets), mode);
      for (const secret of Object.values(secrets)) {
        expect(p.json).not.toContain(secret);
        for (const [name, text] of Object.entries(surfaces(p))) expect(text, name).not.toContain(secret.slice(8, 20));
      }
      expect(p.report.blocked).toBe(false);
      expect(p.report.suspicious).toEqual([]);
      expect(p.report.dropped).toEqual({ "entry-1": 1, "entry-2": 1, "entry-3": 1, "label:bookmark": 1 });
    });
  }
});
