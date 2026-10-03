/**
 * ass-uho0: defense in depth in the final re-scan. If a secret was cut in two before redaction, the half that remains
 * matches no rule and no known value; the re-scan therefore also looks for a long prefix or suffix of every known
 * value and of every secret the patterns redacted. It is a backstop: it must stay quiet on ordinary shares, whose
 * known values often start or end with ordinary text. Only planted fakes; assertions are on rules and lengths.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.js";
import { generateFixtures } from "../src/fixtures/index.js";
import { prepareShare } from "../src/pipeline.js";
import { Redactor } from "../src/redact/index.js";
import { knownSecret, readSecretsFile } from "../src/redact/known-values.js";
import { FRAGMENT_POLICY, rescanPayload } from "../src/redact/rescan.js";
import { formatReport } from "../src/report.js";
import { SHARE_MODES } from "../src/schema.js";
import { ClaudeTranscript, ccUsage, fake, randomish } from "./helpers.js";

const machine = { homeDir: "/home/tester", username: "tester", hostname: "box" };
const payload = (text: string): string => JSON.stringify({ turns: [{ index: 0, steps: [{ kind: "text", text }] }] });
const rules = (json: string, opts: Parameters<typeof rescanPayload>[1]) => rescanPayload(json, opts).issues.map((i) => i.rule);

const claude = (prompt: string) =>
  new ClaudeTranscript("aaaaaaaa-0000-0000-0000-000000000000", "/home/tester/work/demo")
    .user(prompt)
    .assistant("m1", [{ type: "text", text: "on it" }], ccUsage(1, 1))
    .toJsonl();

describe("a long prefix or suffix of a known value", () => {
  const value = fake.envValue(); // 32 characters: fragments of 20
  const known = [knownSecret(value, "SERVICE_TOKEN", "env")];

  it("is flagged by rule and length, never by value", () => {
    const n = FRAGMENT_POLICY.minFragment;
    const prefix = rescanPayload(payload(`leftover ${value.slice(0, 26)} cut`), { knownSecrets: known });
    expect(prefix.issues).toEqual([{ rule: "secret-prefix:SERVICE_TOKEN", length: Math.max(n, Math.ceil(value.length * FRAGMENT_POLICY.ratio)) }]);
    const suffix = rescanPayload(payload(`leftover ${value.slice(-26)} cut`), { knownSecrets: known });
    expect(suffix.issues.map((i) => i.rule)).toEqual(["secret-suffix:SERVICE_TOKEN"]);
    for (const issue of [...prefix.issues, ...suffix.issues]) for (let i = 0; i + 6 <= value.length; i += 2) expect(JSON.stringify(issue)).not.toContain(value.slice(i, i + 6));
  });

  it("blocks the share, and no report surface carries a window of the value", () => {
    // The raw transcript holds only a long prefix of the value (a cut upstream of this pipeline), so nothing redacts it.
    const prepared = prepareShare(claude(`look at this\n${value.slice(0, 27)} in the logs`), { mode: "full", config: DEFAULT_CONFIG, machine, knownSecrets: known });
    expect(prepared.report.blocked).toBe(true);
    expect(prepared.report.rescan.map((i) => i.rule)).toEqual(["secret-prefix:SERVICE_TOKEN"]);
    const surfaces = [formatReport(prepared.report, { maxFindings: Infinity }), JSON.stringify(prepared.report)];
    for (const text of surfaces) for (let i = 0; i + 8 <= value.length; i++) expect(text).not.toContain(value.slice(i, i + 8));
  });

  it("is found in decoded text (a fragment holding a quote and a backslash)", () => {
    const tricky = `Qm"${randomish(22, 5)}\\${randomish(10, 6)}`;
    const k = [knownSecret(tricky, "TRICKY", "env")];
    expect(rules(payload(`x ${tricky.slice(0, 26)} y`), { knownSecrets: k })).toEqual(["secret-prefix:TRICKY"]);
  });

  it("is not checked when allowlisted, nor when the value is short", () => {
    expect(rules(payload(`x ${value.slice(0, 26)}`), { knownSecrets: known, allowlist: [value] })).toEqual([]);
    const short = fake.aws(); // 20 characters
    expect(rules(payload(`x ${short.slice(0, 18)}`), { knownSecrets: [knownSecret(short, "AWS", "env")] })).toEqual([]);
  });

  it("is not flagged when the fragment is shorter than the policy asks", () => {
    expect(rules(payload(`x ${value.slice(0, FRAGMENT_POLICY.minFragment - 1)}`), { knownSecrets: known })).toEqual([]);
  });
});

describe("a long prefix or suffix of a secret that a pattern redacted", () => {
  it("is flagged through the Redactor's private matches, without the value appearing anywhere", () => {
    const token = fake.github();
    const redactor = new Redactor({});
    expect(redactor.redactText(`token ${token} here`)).not.toContain(token);
    const matched = redactor.matchedSecrets();
    expect(matched.length).toBe(1);
    expect(JSON.stringify(matched)).not.toContain(token.slice(0, 8));
    const result = rescanPayload(payload(`cut ${token.slice(0, 30)}`), { matchedSecrets: matched });
    // Measured on real sessions at a non-zero rate and not allowlistable: asks for a confirmation instead of blocking.
    expect(result.issues).toEqual([]);
    expect(result.suspicious.length).toBe(1);
    expect(result.suspicious[0]).toMatchObject({ length: 20, occurrences: 1 });
    expect(result.suspicious[0]?.rule).toMatch(/^secret-prefix:/);
    expect(result.suspicious[0]?.location).toMatch(/turn 1/);
    expect(JSON.stringify(result)).not.toContain(token.slice(0, 8));
  });

  it("asks for a confirmation through the real pipeline, and no report surface carries a window of the token", () => {
    const token = fake.github();
    // Glued to a letter, so the pattern's boundary rule does not match it: only the fragment check can see it.
    const prepared = prepareShare(claude(`go\n${token} then x${token.slice(0, 30)}`), { mode: "full", config: DEFAULT_CONFIG, machine, knownSecrets: [] });
    expect(prepared.report.blocked).toBe(false);
    expect(prepared.report.suspicious.map((s) => s.rule)).toEqual([expect.stringMatching(/^secret-prefix:/)]);
    for (const text of [formatReport(prepared.report, { maxFindings: Infinity }), JSON.stringify(prepared.report)]) for (let i = 0; i + 8 <= token.length; i++) expect(text).not.toContain(token.slice(i, i + 8));
  });

  it("flags nothing when the payload holds only the redacted token", () => {
    const token = fake.anthropic();
    const redactor = new Redactor({});
    const text = redactor.redactText(`key ${token} end`);
    expect(rescanPayload(payload(text), { matchedSecrets: redactor.matchedSecrets() })).toEqual({ issues: [], suspicious: [] });
  });
});

describe("ordinary shares stay unflagged", () => {
  // Values whose start or end is ordinary text a transcript repeats; the secret part never appears.
  const PARTS: Array<[string, string, string, string]> = [
    ["DATABASE_URL", "postgres://app_user:", "Xk3mQ9vTz2LpW7", "@db.internal.example.com:5432/appdb"],
    ["REDIS_URL", "redis://default:", "aB3dE5gH7jK9mN1pQ3", "@cache.example.com:6379/0"],
    ["SLACK_WEBHOOK", "https://hooks.slack.com/services/", "T01ABCDEF/B02GHIJKL/xY7zA1bC3dE5fG7hI9jK2lM4", ""],
    ["SENTRY_DSN", "https://", "a1b2c3d4e5f60718293a4b5c6d7e8f90", "@o123456.ingest.sentry.io/4501234"],
    ["S3_URL", "s3://prod-backups-bucket/exports/2026/", "Zk4Lm8Np2Qr6St0U", ""],
    ["MONGO_URI", "mongodb+srv://svc:", "Hj5Kl9Mn3Pq7Rs1T", "@cluster0.abcde.mongodb.net/prod?retryWrites=true"],
    ["JWT_SECRET", "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.", "eyJzdWIiOiIxMjM0NTY3ODkwIn0.Dq8Wf2Ns6Yt0Vh4Bk8Mj2Lp6", ""],
    ["FILE_PATH_VALUE", "/var/lib/app/releases/current/config/", "k9Xv2Lq7Wm4Zt1Rb", "/settings.json"],
    ["PREFIXED_ID", "arn:aws:iam::123456789012:role/", "ServiceRoleQ9x2Lm7Wv4Zt", ""],
  ];
  const known = PARTS.map(([name, a, m, z]) => knownSecret(a + m + z, name, "env"));

  it.each(SHARE_MODES)("URL-, DSN-, webhook- and JWT-shaped known values whose ordinary start and end appear in the transcript (%s)", (mode) => {
    const prompt = ["please check", ...PARTS.map(([, a, , z]) => `${a} ... ${z}`), "all of the above"].join("\n");
    const prepared = prepareShare(claude(prompt), { mode, config: DEFAULT_CONFIG, machine, knownSecrets: known });
    expect(prepared.report.rescan).toEqual([]);
    expect(prepared.report.blocked).toBe(false);
  });

  it("the fixture sessions, every mode and harness, with their planted secrets as known values", () => {
    const dir = mkdtempSync(join(tmpdir(), "uho0-"));
    try {
      for (const seed of [1, 2, 3]) {
        const fx = generateFixtures({ outDir: join(dir, String(seed)), seed, extraTurns: 10 * seed, home: machine.homeDir, username: machine.username });
        const secrets = readSecretsFile(fx.secretsFile);
        for (const file of [fx.claudeFile, fx.piFile]) {
          const raw = readFileSync(file, "utf8");
          for (const mode of SHARE_MODES) {
            const { report } = prepareShare(raw, { mode, config: DEFAULT_CONFIG, machine, knownSecrets: secrets });
            expect({ seed, mode, rescan: report.rescan.map((i) => i.rule) }).toEqual({ seed, mode, rescan: [] });
            expect(report.blocked).toBe(false);
          }
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
