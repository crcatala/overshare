/**
 * The report is what people paste into issues and CI logs, so it must never carry secret content: not a
 * preview, not the text around a finding, not a data-derived label. These tests plant fake secrets and
 * check the output of the real pipeline, report formatter and browse summary (nothing here can leak by mock).
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { summarizeShare } from "../src/browse/source.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { prepareShare, type PrepareOptions } from "../src/pipeline.js";
import { Redactor } from "../src/redact/index.js";
import { knownSecret, readSecretsFile } from "../src/redact/known-values.js";
import { rescanPayload } from "../src/redact/rescan.js";
import { safeLabel } from "../src/redact/labels.js";
import { formatReport } from "../src/report.js";
import { spawnSync } from "node:child_process";
import { ClaudeTranscript, ccUsage, fake, randomish } from "./helpers.js";

const machine = { homeDir: "/home/tester", username: "tester", hostname: "box" };

/** Every way the report reaches a reader: the human report, the `--json` report and the browse review. */
function surfaces(prepared: ReturnType<typeof prepareShare>): Record<string, string> {
  return {
    human: formatReport(prepared.report, { maxFindings: Infinity }),
    json: JSON.stringify({ path: "x.jsonl", ...prepared.report }, null, 2),
    browse: JSON.stringify(summarizeShare(prepared)),
  };
}

/** Windows of `secret` (length > 2) that appear in `output` but not in the secret-free `baseline`. */
function leakedFragments(output: string, secret: string, baseline: string, size = 3): string[] {
  const out: string[] = [];
  for (let i = 0; i + size <= secret.length; i++) {
    const w = secret.slice(i, i + size);
    if (output.includes(w) && !baseline.includes(w)) out.push(w);
  }
  return out;
}

const transcript = (toolInput: Record<string, unknown>, result = "ok", toolName = "Bash") =>
  new ClaudeTranscript("aaaaaaaa-0000-0000-0000-000000000000", "/home/tester/work/demo")
    .user("run it")
    .assistant("m1", [{ type: "tool_use", id: "b1", name: toolName, input: toolInput }], ccUsage(1, 1))
    .toolResult("b1", result)
    .assistant("m2", [{ type: "text", text: "done" }], ccUsage(1, 1))
    .toJsonl();

const prepare = (raw: string, extra: Partial<PrepareOptions> = {}) =>
  prepareShare(raw, { mode: "full", config: DEFAULT_CONFIG, machine, knownSecrets: [], ...extra });

describe("final re-scan issues carry no secret content", () => {
  // Object keys are not redacted, so a secret-shaped key reaches the payload and only the re-scan sees it.
  it("a pattern hit in the payload is reported by rule and length only", () => {
    const secret = fake.github();
    const raw = transcript({ command: "run", [secret]: 1 });
    const prepared = prepare(raw);
    expect(prepared.report.blocked).toBe(true);
    expect(prepared.report.rescan[0]).toMatchObject({ rule: "github-v2", length: secret.length });

    const baseline = Object.values(surfaces(prepare(transcript({ command: "run" })))).join("\n");
    for (const [name, text] of Object.entries(surfaces(prepared))) {
      expect(leakedFragments(text, secret, baseline), name).toEqual([]);
    }
  });

  it("a known secret in the payload is identified by label, with no value characters", () => {
    const value = fake.envValue();
    const known = [knownSecret(value, "GH_TOKEN", "env")];
    const prepared = prepare(transcript({ command: "run", [value]: 1 }), { knownSecrets: known });
    expect(prepared.report.rescan[0]).toMatchObject({ rule: "known-secret:GH_TOKEN", length: value.length });
    expect(formatReport(prepared.report)).toContain("known-secret:GH_TOKEN");

    const baseline = Object.values(surfaces(prepare(transcript({ command: "run" }), { knownSecrets: known }))).join("\n");
    for (const [name, text] of Object.entries(surfaces(prepared))) {
      expect(leakedFragments(text, value, baseline), name).toEqual([]);
    }
  });

  it("the CLI report (stdout, stderr and --json) of a blocked session has no fragment of the secret", () => {
    const secret = fake.github();
    const dir = mkdtempSync(join(tmpdir(), "as-leak-"));
    const home = mkdtempSync(join(tmpdir(), "as-leak-home-"));
    const run = (raw: string, ...args: string[]) => {
      const file = join(dir, "s.jsonl");
      writeFileSync(file, raw);
      const r = spawnSync(process.execPath, ["--import", "tsx", join(import.meta.dirname, "..", "src", "cli.ts"), "report", file, "--mode", "full", ...args], {
        encoding: "utf8",
        env: { PATH: process.env.PATH ?? "", HOME: home, XDG_CONFIG_HOME: join(home, ".config"), NO_COLOR: "1", PI_CODING_AGENT_DIR: join(home, "pi"), CLAUDE_CONFIG_DIR: join(home, "claude") },
        input: "",
      });
      return { status: r.status, text: [r.stdout, r.stderr].join("\n") };
    };
    const leaky = transcript({ command: "run", [secret]: 1 });
    const human = run(leaky);
    const json = run(leaky, "--json");
    expect(human.status).toBe(3);
    expect(human.text).toContain("Final re-scan: 1 issue");
    const baseline = [run(transcript({ command: "run" })).text, run(transcript({ command: "run" }), "--json").text].join("\n");
    for (const out of [human, json]) expect(leakedFragments(out.text, secret, baseline)).toEqual([]);
  }, 30_000);
});

describe("findings carry no surrounding text", () => {
  // `.env` dumps often hold one secret we know next to one nothing recognizes. The neighbor must not be
  // echoed back by the report just because it sits next to a finding.
  const neighbor = "Tr0ub4dor&3xyz";

  it("does not print the unredacted neighbor of a redacted known secret", () => {
    const value = fake.envValue();
    const known = [knownSecret(value, "DB_PASS", "env")];
    const raw = transcript({ command: "cat .env" }, `DB_PASS=${value} and the root pw is ${neighbor}`);
    const prepared = prepare(raw, { knownSecrets: known });
    // The test is only meaningful if the neighbor really slipped through every layer.
    expect(prepared.json).toContain(neighbor);
    expect(prepared.json).not.toContain(value);
    expect(prepared.report.findings.length).toBeGreaterThan(0);

    for (const [name, text] of Object.entries(surfaces(prepared))) {
      expect(text, name).not.toContain(neighbor);
      expect(text, name).not.toContain("root pw");
    }
    const review = summarizeShare(prepared);
    for (const f of [...prepared.report.findings, ...review.findings]) expect(Object.keys(f)).not.toContain("context");
  });

  it("the sensitive-key finding does not echo the key either", () => {
    const r = new Redactor(machine);
    r.redactField("password", `Hunter2${randomish(8)}`, "turn 1 · prompt");
    expect(r.findings).toEqual([{ category: "secret-pattern", rule: "sensitive-key:password (medium)", where: "turn 1 · prompt" }]);
  });
});

describe("data-derived labels", () => {
  it("safeLabel keeps identifier-shaped names and replaces everything else", () => {
    for (const ok of ["GH_TOKEN", "DB_PASS", "claudeAiOauth.accessToken", "mcp__claude_ai_Claude_Docs__batch", "sensitive:key-1", "token"]) {
      expect(safeLabel(ok, "x")).toBe(ok);
    }
    expect(safeLabel("has space", "x")).toBe("x");
    expect(safeLabel("a/b", "x")).toBe("x");
    expect(safeLabel("[REDACTED:evil]", "x")).toBe("x");
    expect(safeLabel("a".repeat(65), "x")).toBe("x");
    expect(safeLabel("", "x")).toBe("x");
    expect(safeLabel(fake.github(), "x")).toBe("x");
    expect(safeLabel(fake.aws(), "x")).toBe("x");
    expect(safeLabel(`${fake.anthropic()}-secret`, "x")).toBe("x");
    expect(safeLabel(randomish(40, 5), "x")).toBe("x");
  });

  it("a secret-shaped key under a sensitive-key path never reaches the report or the redaction token", () => {
    const key = `secret-${randomish(40, 5)}`;
    const raw = transcript({ command: "run", [key]: `Hunter2${randomish(10, 9)}` });
    const prepared = prepare(raw);
    expect(prepared.json).toContain("[REDACTED:key]");
    expect(prepared.json).not.toContain(`[REDACTED:${key}`);
    expect(prepared.report.findings.some((f) => f.rule === "sensitive-key:key (medium)")).toBe(true);
    // The key itself is not redacted by redaction, so the re-scan or the payload may still hold it; the report must not.
    for (const [name, text] of Object.entries(surfaces(prepared))) expect(text, name).not.toContain(key);
  });

  it("a known-secret label shaped like a secret is replaced in the payload token and the report", () => {
    const value = fake.envValue();
    const label = fake.anthropic();
    const raw = transcript({ command: "cat" }, `out ${value}`);
    const prepared = prepare(raw, { knownSecrets: [knownSecret(value, label, "env")] });
    expect(prepared.json).toContain("[REDACTED:secret]");
    for (const [name, text] of Object.entries({ ...surfaces(prepared), payload: prepared.json })) expect(text, name).not.toContain(label);
  });

  it("a tool named like a token appears in neither the report nor the published stats", () => {
    const name = fake.github();
    const prepared = prepare(transcript({ command: "x" }, "ok", name));
    // The name is itself redacted in the payload, so it is a finding; it is located by the generic name.
    expect(prepared.report.findings.map((f) => f.where)).toEqual(["turn 0 · tool"]);
    const all = { ...surfaces(prepared), payload: prepared.json };
    for (const [n, text] of Object.entries(all)) expect(text, n).not.toContain(name);
    expect(prepared.report.stats.tools).toEqual({ tool: 1 });
  });

  it("a finding inside a secret-named tool is located by a generic tool name", () => {
    const name = fake.github();
    const prepared = prepare(transcript({ command: "x" }, `TOKEN=${fake.github()}`, name));
    expect(prepared.report.findings.map((f) => f.where)).toEqual(["turn 0 · tool", "turn 0 · tool"]);
  });
});

describe("known-secret labels that are part of a known value", () => {
  // An ambiguous `name=value` line in a secrets file is labelled by the text before the `=`, which is
  // part of the secret. The label ends up in the published token, the report and the re-scan.
  const prefix = `pw${randomish(10, 41)}`;
  const tail = `Z${randomish(12, 43)}`;
  const secretsFile = () => {
    const file = join(mkdtempSync(join(tmpdir(), "as-labels-")), "secrets.env");
    writeFileSync(file, `${prefix}=${tail}\n`);
    return readSecretsFile(file);
  };

  it("readSecretsFile labels ambiguous lines generically", () => {
    expect(secretsFile().map((k) => k.label)).toEqual(["secret", "secret"]);
  });

  it("the Redactor never uses a label that appears inside a known value, whatever produced it", () => {
    const known = [knownSecret(tail, prefix, "secrets-file"), knownSecret(`${prefix}=${tail}`, "secret", "secrets-file")];
    const r = new Redactor({ ...machine, knownSecrets: known });
    const out = r.redactText(`only the tail: ${tail} here`, "t");
    expect(out).toBe("only the tail: [REDACTED:secret] here");
    expect(JSON.stringify(r.findings)).not.toContain(prefix);
  });

  it("the re-scan does not name a known secret by a label that is part of a known value", () => {
    const known = [knownSecret(tail, prefix, "secrets-file"), knownSecret(`${prefix}=${tail}`, "secret", "secrets-file")];
    const issues = rescanPayload(JSON.stringify({ a: tail }), { knownSecrets: known });
    expect(issues.map((i) => i.rule)).toEqual(["known-secret:secret"]);
  });

  it("end to end: a secrets-file line whose tail shows up alone is not published with its prefix", () => {
    const prepared = prepare(transcript({ command: "cat" }, `out ${tail}`), { knownSecrets: secretsFile() });
    for (const [name, text] of Object.entries({ ...surfaces(prepared), payload: prepared.json })) expect(text, name).not.toContain(prefix);
    expect(prepared.json).toContain("[REDACTED:secret]");
  });
});
