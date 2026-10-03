import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Redactor } from "../src/redact/index.js";
import { collectKnownSecrets, knownSecret, readSecretsFile } from "../src/redact/known-values.js";
import { findSecretPatterns, looksLikeSecret } from "../src/redact/patterns.js";
import { rescanPayload } from "../src/redact/rescan.js";
import { fake, randomish } from "./helpers.js";

const machine = { homeDir: "/home/tester", username: "tester" };

describe("pattern detection", () => {
  it.each([
    ["github token", () => `token is ${fake.github()} ok`],
    ["anthropic key", () => `key=${fake.anthropic()}`],
    ["aws access key", () => `aws ${fake.aws()} here`],
    ["pem private key", () => `key:\n${fake.pem()}\n`],
    ["connection string password", () => `DATABASE_URL=${fake.postgres()}`],
    ["password assignment", () => `const password = "Hunter2${randomish(6)}"`],
    ["age secret key", () => `# public key: age1xyz\n${fake.age()}`],
    ["bearer header", () => `Authorization: Bearer ${randomish(40, 3)}`],
  ])("redacts a %s", (_name, make) => {
    const r = new Redactor(machine);
    const input = make();
    const out = r.redactText(input, "test");
    expect(out).toContain("[REDACTED:");
    expect(r.counts["secret-pattern"]).toBeGreaterThan(0);
    expect(rescanPayload(JSON.stringify({ text: out })).issues).toEqual([]);
  });

  it.each([
    ["git sha", "commit 8309559a1b2c3d4e5f60718293a4b5c6d7e8f901 merged"],
    ["uuid", "session 2143f7bc-9cd4-48c1-927c-cd132e187178"],
    ["integrity hash", "sha512-iIg7k2xntmwu6/uSb5tpc/hySgZc4eoL31yB29W6tJFo2akwjPWcEqnCEdJvGexCL0KEQwVYv5BlowfhVz26hg=="],
    ["file mode in diff", "diff --git a/README.md b/README.md index a1075ab..84bf749 100644"],
    ["identifiers", "const discoveryConcurrency = args.concurrency; export function listCustomersForOrganizationWithPaging() {}"],
    ["placeholder assignment", 'password: ${{ secrets.DB_PASSWORD }}, token = process.env.GH_TOKEN, apiKey: config.apiKey'],
    ["doc example key", `AWS_ACCESS_KEY_ID=${"AKIA"}IOSFODNN7EXAMPLE`],
    ["url placeholder creds", "--proxy http://user:password@127.0.0.1:7890"],
    ["build artifact", "libtauri_plugin_http-715d0463b3990f9b,libreqwest-1df712e7440f2fd2"],
  ])("leaves %s alone", (_name, input) => {
    const r = new Redactor(machine);
    expect(r.redactText(input)).toBe(input);
    expect(r.findings).toEqual([]);
  });

  it("finds secrets that straddle a chunk boundary in very long strings", () => {
    const secret = fake.github();
    const text = `${"lorem ipsum ".repeat(2730)}${secret} ${"dolor ".repeat(20000)}`; // secret starts ~32.7k chars in
    const matches = findSecretPatterns(text);
    expect(matches.some((m) => text.slice(m.start, m.end) === secret)).toBe(true);
  });

  it("looksLikeSecret requires randomness", () => {
    expect(looksLikeSecret(randomish(32))).toBe(true);
    expect(looksLikeSecret("qwen3-coder-480b-a35b-instruct")).toBe(false);
    expect(looksLikeSecret("1790531351_ls-hidden.log")).toBe(false);
  });
});

describe("Redactor", () => {
  it("replaces known local secret values exactly, with their label", () => {
    const value = fake.envValue();
    const r = new Redactor({ ...machine, knownSecrets: [knownSecret(value, "MY_SERVICE_KEY", "env")] });
    const out = r.redactText(`$ env\nMY_SERVICE_KEY=${value}\nOTHER=1`, "turn 1 · Bash");
    expect(out).toBe("$ env\nMY_SERVICE_KEY=[REDACTED:MY_SERVICE_KEY]\nOTHER=1");
    expect(r.findings[0]).toMatchObject({ category: "known-secret", rule: "MY_SERVICE_KEY (env)", where: "turn 1 · Bash" });
  });

  it("rewrites home paths, path slugs and the username but keeps project names", () => {
    const r = new Redactor(machine);
    const out = r.redactText("cd /home/tester/work/agent-sandbox && ls ~/.claude/projects/-home-tester-work-agent-sandbox; whoami => tester");
    expect(out).toBe("cd ~/work/agent-sandbox && ls ~/.claude/projects/-home-[user]-work-agent-sandbox; whoami => [user]");
    expect(r.counts).toMatchObject({ "home-path": 2, username: 1 });
    expect(r.secretCount).toBe(0);
  });

  it("does not treat a longer sibling directory as the home dir", () => {
    const r = new Redactor(machine);
    expect(r.redactText("/home/tester2/x")).toBe("/home/tester2/x");
  });

  it("redacts emails except safe/no-reply ones; honors allowlist and denylist", () => {
    const r = new Redactor({ ...machine, allowlist: ["team@public.dev"], denylist: ["Project Nightingale"] });
    const out = r.redactText(
      "mail jane.doe@corp.io or team@public.dev; Co-Authored-By: Bot <noreply@anthropic.com>; codename project nightingale",
    );
    expect(out).toBe("mail [email] or team@public.dev; Co-Authored-By: Bot <noreply@anthropic.com>; codename [REDACTED]");
  });

  it("redacts literal values under sensitive keys in structured tool input", () => {
    const r = new Redactor(machine);
    expect(r.redactField("api_key", `k${randomish(20)}9`, "turn 0 · http")).toBe("[REDACTED:api_key]");
    expect(r.redactField("api_key", "${API_KEY}", "")).toBe("${API_KEY}");
    expect(r.redactField("tokens", "not-a-secret-key", "")).toBe("not-a-secret-key");
  });
});

describe("collectKnownSecrets", () => {
  it("collects secret-looking env vars, credential files and project .env files", () => {
    const home = mkdtempSync(join(tmpdir(), "as-home-"));
    const project = mkdtempSync(join(tmpdir(), "as-proj-"));
    const credFile = join(home, "auth.json");
    const oauth = randomish(40, 5);
    writeFileSync(credFile, JSON.stringify({ anthropic: { type: "oauth", access: oauth, expires: 1234567890 } }));
    const dotenvValue = randomish(24, 9);
    writeFileSync(join(project, ".env"), `DB_PASSWORD="${dotenvValue}"\nPORT=3000\n`);
    writeFileSync(join(project, ".env.example"), `DB_PASSWORD=${randomish(24, 10)}\n`);
    const envValue = fake.envValue();
    const found = collectKnownSecrets({
      env: { MY_API_KEY: envValue, HOME_DIR: "/home/x", SHORT_TOKEN: "abc", CLAUDE_CODE_SESSION_ID: "1234-5678-abcd", ENABLE_AUTH: "true" },
      home,
      projectDir: project,
      enabled: { credentialFiles: true },
      jsonCredentialFiles: [credFile],
    }).secrets;
    const byLabel = Object.fromEntries(found.map((k) => [k.label, k]));
    expect(byLabel.MY_API_KEY?.value.equals(envValue)).toBe(true);
    expect(byLabel["anthropic.access"]?.value.equals(oauth)).toBe(true);
    expect(byLabel.DB_PASSWORD?.value.equals(dotenvValue)).toBe(true);
    expect(found.map((k) => k.label)).not.toContain("CLAUDE_CODE_SESSION_ID");
    expect(found.map((k) => k.label)).not.toContain("SHORT_TOKEN");
    expect(found.map((k) => k.label)).not.toContain("ENABLE_AUTH");
    expect(found).toHaveLength(3);
  });
});

describe("rescanPayload", () => {
  it("flags known values, high-confidence patterns and home paths left in the payload", () => {
    const known = fake.envValue();
    const payload = JSON.stringify({ a: `x ${known}`, b: `y ${fake.github()}`, c: "/home/tester/secret-project" });
    const { issues } = rescanPayload(payload, { knownSecrets: [knownSecret(known, "K", "env")], homeDir: "/home/tester" });
    expect(issues.map((i) => i.rule)).toEqual(["known-secret:K", "github-v2", "home-path"]);
    expect(issues.map((i) => i.length)).toEqual([known.length, expect.any(Number), undefined]);
    expect(JSON.stringify(issues)).not.toContain(known.slice(0, 4));
  });
});

describe("readSecretsFile", () => {
  function parse(content: string) {
    const file = join(mkdtempSync(join(tmpdir(), "as-sf-")), "secrets.env");
    writeFileSync(file, content);
    const warnings: string[] = [];
    const values = readSecretsFile(file, (w) => warnings.push(w));
    // `SecretValue` has no accessor, so entries are checked through `equals`.
    const has = (label: string, value: string) => values.some((k) => k.label === label && k.value.equals(value));
    return { values, has, warnings };
  }

  it("splits env-style KEY=VALUE lines, keeping = inside values and stripping quotes", () => {
    const { values, has } = parse('DB_PASSWORD=pa=ss=word123\nexport API_KEY="quoted-value"\n# comment\n\n');
    expect(values).toHaveLength(2);
    expect(has("DB_PASSWORD", "pa=ss=word123")).toBe(true);
    expect(has("API_KEY", "quoted-value")).toBe(true);
  });

  it("keeps bare values whole — base64 padding and embedded = never drop or leak a prefix", () => {
    const { has } = parse("c2VjcmV0LWJhc2U2NC12YWx1ZQ==\nabc=defghijklmnop\n");
    expect(has("secret", "c2VjcmV0LWJhc2U2NC12YWx1ZQ==")).toBe(true);
    expect(has("secret", "abc=defghijklmnop")).toBe(true);
    // The ambiguous "abc=" line also redacts its tail on its own, labelled generically (the "abc" may be part of the secret).
    expect(has("secret", "defghijklmnop")).toBe(true);
  });

  it("also redacts the value of a lowercase key on its own", () => {
    const { values, has } = parse("db_password=hunter2xyz\n");
    expect(values).toHaveLength(2);
    expect(has("secret", "db_password=hunter2xyz")).toBe(true);
    expect(has("secret", "hunter2xyz")).toBe(true);
  });

  it("warns about values too short to redact safely", () => {
    const { values, has, warnings } = parse("TOO=ab\nxy\nOK_KEY=long-enough\n");
    expect(values).toHaveLength(1);
    expect(has("OK_KEY", "long-enough")).toBe(true);
    expect(warnings).toEqual([expect.stringMatching(/:1: value for TOO is shorter/), expect.stringMatching(/:2: value is shorter/)]);
  });
});
