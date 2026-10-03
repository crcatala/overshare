/**
 * Known secrets are the exact values of every credential on the machine, so an accidental print of one
 * (a debug log, a stringified error, a serialized state object) leaks all of them at once. `SecretValue`
 * makes that impossible by construction. These tests plant fake secrets in every harvesting source, force
 * the failure paths where such accidents happen, and check the text that actually comes out (nothing here
 * can leak by mock: the real collector, pipeline, publisher and CLI run).
 */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { format, inspect } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { summarizeShare } from "../src/browse/job.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { prepareShare } from "../src/pipeline.js";
import { GistPublisher } from "../src/publish/gist.js";
import { publishPrepared } from "../src/publish/index.js";
import type { PublishPayload, Publisher } from "../src/publish/types.js";
import { Redactor } from "../src/redact/index.js";
import { collectKnownSecrets, knownSecret, type KnownSourceSettings } from "../src/redact/known-values.js";
import { rescanPayload } from "../src/redact/rescan.js";
import { SecretValue } from "../src/redact/secret-value.js";
import { formatReport } from "../src/report.js";
import { ClaudeTranscript, ccUsage, fake, randomish } from "./helpers.js";

const root = join(import.meta.dirname, "..");

/** The leak tests want the widest harvesting surface, so every opt-in source is switched on. */
const ALL_SOURCES: KnownSourceSettings = { env: true, projectEnv: true, credentialFiles: true, ghToken: true };
const ALL_ON = { ...DEFAULT_CONFIG, redact: { ...DEFAULT_CONFIG.redact, knownSources: ALL_SOURCES } };

describe("SecretValue", () => {
  const raw = `Zq${randomish(30, 91)}`;
  const secret = new SecretValue(raw);
  const known = knownSecret(raw, "SERVICE_TOKEN", "env");

  const cases: Array<[string, () => string]> = [
    ["JSON.stringify(secret)", () => JSON.stringify(secret)],
    ["String(secret)", () => String(secret)],
    ["template literal", () => `${secret}`],
    ["string concatenation", () => `value: ${"" + secret}`],
    ["util.inspect(secret)", () => inspect(secret, { depth: null, showHidden: true })],
    ["util.format %s %j %o %O", () => format("%s %j %o %O", secret, secret, secret, secret)],
    ["JSON.stringify(known secret object)", () => JSON.stringify(known)],
    ["util.inspect(known secret object)", () => inspect(known, { depth: null, showHidden: true })],
    ["JSON.stringify({ secrets: [secret] })", () => JSON.stringify({ secrets: [secret] })],
    ["Error message that interpolates the value", () => new Error(`failed with ${known.value}`).message],
    ["Error stack of that error", () => String(new Error(`failed with ${known.value}`).stack)],
    ["structuredClone of the wrapper", () => inspect(structuredClone(secret), { depth: null, showHidden: true })],
    ["own property names and values", () => JSON.stringify(Object.getOwnPropertyNames(secret).map((k) => [k, (secret as never)[k]]))],
  ];

  it.each(cases)("%s never contains the value", (_name, render) => {
    const out = render();
    expect(out).not.toContain(raw);
    for (let i = 0; i + 6 <= raw.length; i += 3) expect(out).not.toContain(raw.slice(i, i + 6));
  });

  it("console.log of the wrapper, of a known secret and of nested structures never contains the value", () => {
    const calls: unknown[][] = [];
    const methods = ["log", "info", "warn", "error", "debug"] as const;
    const spies = methods.map((m) => vi.spyOn(console, m).mockImplementation((...args: unknown[]) => void calls.push(args)));
    try {
      for (const m of methods) console[m](secret);
      console.log(known);
      console.log({ secrets: [secret] });
      console.error("known secrets:", [known], { nested: { deep: [{ known }] } });
    } finally {
      for (const s of spies) s.mockRestore();
    }
    const text = calls.map((args) => args.map((a) => (typeof a === "string" ? a : inspect(a, { depth: null }))).join(" ")).join("\n");
    expect(calls.length).toBeGreaterThan(0);
    expect(text).toContain("[redacted]");
    expect(text).not.toContain(raw);
  });

  it("keeps label and source printable", () => {
    expect(JSON.parse(JSON.stringify(known))).toEqual({ value: "[redacted]", label: "SERVICE_TOKEN", source: "env" });
  });

  it("matches without handing the value out", () => {
    expect(secret.length).toBe(raw.length);
    expect(secret.isIn(`a ${raw} b ${raw}`)).toBe(true);
    expect(secret.isIn("nothing here")).toBe(false);
    expect(secret.countIn(`a ${raw} b ${raw}`)).toBe(2);
    expect(secret.replaceIn(`a ${raw} b`, "[X]")).toBe("a [X] b");
    expect(secret.contains(raw.slice(4, 12))).toBe(true);
    expect(secret.inSet(new Set([raw]))).toBe(true);
    expect(secret.inSet(new Set(["other"]))).toBe(false);
    expect(secret.equals(raw)).toBe(true);
  });

  it("looks for a long prefix or suffix and reports which end and how long, never the fragment", () => {
    const policy = { minValueLength: 24, ratio: 0.5, minFragment: 20, maxFragment: 32, minRun: 16, minEntropy: 3, maxWordRatio: 0.4 };
    expect(secret.fragmentLength(policy)).toBe(20);
    expect(secret.hasFragmentIn(`x ${raw.slice(0, 20)} y`, policy)).toBe("prefix");
    expect(secret.hasFragmentIn(`x ${raw.slice(-20)} y`, policy)).toBe("suffix");
    expect(secret.hasFragmentIn(`x ${raw.slice(0, 19)} y`, policy)).toBeUndefined();
    expect(secret.hasFragmentIn("nothing here", policy)).toBeUndefined();
    expect(secret.fragmentLength({ ...policy, minValueLength: raw.length + 1 })).toBe(0);
    // Ordinary text shared with the start of a value is not a fragment: no run of random-looking characters.
    const url = new SecretValue("https://hooks.slack.com/services/T01ABCDEF/B02GHIJKL/xY7zA1bC3dE5");
    expect(url.hasFragmentIn("see https://hooks.slack.com/services/ for the docs", policy)).toBeUndefined();
  });

  it("takes the fragments of a JWT from its signature alone: shared header and claims are not secret", () => {
    const policy = { minValueLength: 24, ratio: 0.5, minFragment: 20, maxFragment: 32, minRun: 16, minEntropy: 3, maxWordRatio: 0.4 };
    const header = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9";
    // A long, issuer-style claims segment shared by every token of the issuer (a public and a service key, say).
    const claims = "eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1vY2twcm9qZWN0cmVmZXJlbmNlIiwicm9sZSI6InNlcnZpY2Vfcm9sZSJ9";
    const signature = randomish(43, 77, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_");
    const jwt = new SecretValue(`${header}.${claims}.${signature}`);
    expect(jwt.fragmentLength(policy)).toBe(22);
    // Nothing of the shared parts counts, however long: the header, the claims, a sibling token's whole header and claims.
    expect(jwt.hasFragmentIn(`a token starts ${header}.`, policy)).toBeUndefined();
    expect(jwt.hasFragmentIn(`another token ${header}.${claims}. cut`, policy)).toBeUndefined();
    expect(jwt.hasFragmentIn(`another token ${header}.${claims}.${randomish(43, 78, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_")}`, policy)).toBeUndefined();
    // A leaked signature prefix or suffix does.
    expect(jwt.hasFragmentIn(`tail ${signature.slice(0, 30)}`, policy)).toBe("prefix");
    expect(jwt.hasFragmentIn(`tail ${signature.slice(-30)}`, policy)).toBe("suffix");
    // An unsigned token has no secret part.
    const unsigned = new SecretValue(`${header}.${claims}.`);
    expect(unsigned.fragmentLength(policy)).toBe(0);
    expect(unsigned.hasFragmentIn(`${header}.${claims}.`, policy)).toBeUndefined();
  });
});

describe("a Redactor that matched secrets by pattern", () => {
  const token = fake.github();
  const redactor = new Redactor({});
  redactor.redactText(`key ${token} here`);
  const windows = (text: string): number => {
    let n = 0;
    for (let i = 0; i + 8 <= token.length; i++) if (text.includes(token.slice(i, i + 8))) n++;
    return n;
  };

  it("prints, serializes and clones without a window of the matched value", () => {
    expect(redactor.matchedSecrets().length).toBe(1);
    const dumps: Array<[string, string]> = [
      ["inspect", inspect(redactor, { depth: null, showHidden: true })],
      ["format", format("%j %o %O", redactor, redactor, redactor)],
      ["JSON", JSON.stringify(redactor)],
      ["entries", inspect(Object.entries(redactor), { depth: null, showHidden: true })],
      ["own property names and values", JSON.stringify(Object.getOwnPropertyNames(redactor).map((k) => [k, inspect((redactor as never)[k], { depth: null, showHidden: true })]))],
      ["structuredClone of own fields", inspect(Object.fromEntries(Object.entries(redactor).map(([k, v]) => [k, v instanceof Map || Array.isArray(v) || v instanceof Set ? structuredClone(v) : String(v)])), { depth: null, showHidden: true })],
      ["matched secrets", inspect(redactor.matchedSecrets(), { depth: null, showHidden: true }) + JSON.stringify(redactor.matchedSecrets())],
    ];
    for (const [name, text] of dumps) expect({ name, windows: windows(text) }).toEqual({ name, windows: 0 });
  });

  it("holds no raw value as a key or an own field: only SecretValues", () => {
    for (const k of Object.getOwnPropertyNames(redactor)) {
      const v = (redactor as never)[k] as unknown;
      expect(v instanceof Map ? [...v.keys()].map(String).join("") : "", k).not.toContain(token.slice(0, 8));
    }
    expect(redactor.matchedSecrets().every((k) => k.value instanceof SecretValue)).toBe(true);
  });
});

describe("SecretValue stays encapsulated", () => {
  const srcFiles = (dir: string): string[] =>
    readdirSync(dir).flatMap((n) => {
      const p = join(dir, n);
      return statSync(p).isDirectory() ? srcFiles(p) : p.endsWith(".ts") ? [p] : [];
    });
  const files = srcFiles(join(root, "src")).map((p) => [p.slice(root.length + 1), readFileSync(p, "utf8")] as const);

  it("exposes only matchers and the string conversions, so no method returns the raw value", () => {
    const names = Object.getOwnPropertyNames(SecretValue.prototype).sort();
    expect(names).toEqual(["constructor", "contains", "countIn", "equals", "fragmentLength", "hasFragmentIn", "inSet", "isIn", "length", "replaceIn", "toJSON", "toString"]);
    expect(Object.getOwnPropertySymbols(SecretValue.prototype).map(String).sort()).toEqual(["Symbol(Symbol.toPrimitive)", "Symbol(nodejs.util.inspect.custom)"]);
  });

  it("is only constructed by the knownSecret factory", () => {
    expect(files.filter(([, text]) => /new SecretValue\(/.test(text)).map(([f]) => f)).toEqual(["src/redact/known-values.ts"]);
  });

  it("only the matcher code calls the matcher methods on a known value", () => {
    const callers = files.filter(([, text]) => /\.value\.(isIn|countIn|replaceIn|contains|inSet|equals|hasFragmentIn|fragmentLength)\(/.test(text)).map(([f]) => f);
    expect(callers.sort()).toEqual(["src/redact/index.ts", "src/redact/labels.ts", "src/redact/rescan.ts"]);
  });

  it("no source file reads a secret through an accessor or re-wraps it as a string", () => {
    for (const [file, text] of files) {
      expect(text, file).not.toMatch(/\.(reveal|unwrap|expose|getValue)\(/);
      expect(text, file).not.toMatch(/\$\{[^}]*\b(k|known|secret)\.value\}/);
    }
  });
});

/** Fake credentials planted in every place `collectKnownSecrets` reads. Values match no secret pattern, so only the known-values layer can catch them. */
function plant() {
  const home = mkdtempSync(join(tmpdir(), "as-leakhome-"));
  const project = mkdtempSync(join(tmpdir(), "as-leakproj-"));
  const bin = mkdtempSync(join(tmpdir(), "as-leakbin-"));
  const v = (seed: number) => `Q${randomish(33, seed)}`;
  const secrets = {
    MY_SERVICE_API_KEY: v(101), // env
    "claudeAiOauth.access": v(102), // ~/.claude/.credentials.json
    "tokens.id_token": v(103), // ~/.codex/auth.json
    gh_hosts: v(104), // ~/.config/gh/hosts.yml
    npmrc: v(105), // ~/.npmrc
    netrc: v(106), // ~/.netrc
    DB_PASSWORD: v(107), // project .env
    GH_TOKEN: v(108), // gh auth token
    SECRETS_FILE: v(109), // extraKnownSecrets
  };
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(join(home, ".codex"), { recursive: true });
  mkdirSync(join(home, ".config", "gh"), { recursive: true });
  writeFileSync(join(home, ".claude", ".credentials.json"), JSON.stringify({ claudeAiOauth: { access: secrets["claudeAiOauth.access"] } }));
  writeFileSync(join(home, ".codex", "auth.json"), JSON.stringify({ tokens: { id_token: secrets["tokens.id_token"] } }));
  writeFileSync(join(home, ".config", "gh", "hosts.yml"), `github.com:\n    oauth_token: ${secrets.gh_hosts}\n`);
  writeFileSync(join(home, ".npmrc"), `//registry.npmjs.org/:_authToken=${secrets.npmrc}\n`);
  writeFileSync(join(home, ".netrc"), `machine example.invalid login me password ${secrets.netrc}\n`);
  writeFileSync(join(project, ".env"), `DB_PASSWORD=${secrets.DB_PASSWORD}\nPORT=3000\n`);
  // A fake `gh`: logged in, hands out a planted token, and fails every other call.
  const gh = join(bin, "gh");
  writeFileSync(gh, `#!/bin/sh\nif [ "$1" = auth ] && [ "$2" = token ]; then echo ${secrets.GH_TOKEN}; exit 0; fi\nif [ "$1" = auth ]; then exit 0; fi\necho "gh: simulated upstream failure (HTTP 502)" >&2\nexit 1\n`);
  chmodSync(gh, 0o755);
  const env = {
    PATH: `${bin}:/usr/bin:/bin`,
    PI_CODING_AGENT_DIR: join(home, "pi"),
    CLAUDE_CONFIG_DIR: join(home, ".claude"),
    MY_SERVICE_API_KEY: secrets.MY_SERVICE_API_KEY,
  };
  return { home, project, secrets, env, values: Object.values(secrets) };
}

type Planted = ReturnType<typeof plant>;

/** The planted value appears whole, or as a long prefix/suffix, in `text`. Returns what leaked. */
function leaks(text: string, planted: Planted): string[] {
  return Object.entries(planted.secrets)
    .filter(([, value]) => text.includes(value) || text.includes(value.slice(0, 12)) || text.includes(value.slice(-12)))
    .map(([name]) => name);
}

/** A transcript in which the agent dumped the planted values (`cat .env`, `printenv`): extra content goes in the tool output. */
function dumpTranscript(p: Planted, opts: { cwd?: string; toolInput?: Record<string, unknown>; output?: string } = {}) {
  const output = opts.output ?? Object.entries(p.secrets).filter(([k]) => k !== "SECRETS_FILE").map(([k, value]) => `${k}=${value}`).join("\n");
  return new ClaudeTranscript("bbbbbbbb-0000-0000-0000-000000000000", opts.cwd ?? p.project)
    .user("show me the config")
    .assistant("m1", [{ type: "tool_use", id: "b1", name: "Bash", input: opts.toolInput ?? { command: "cat .env; printenv" } }], ccUsage(1, 1))
    .toolResult("b1", output)
    .assistant("m2", [{ type: "text", text: "done" }], ccUsage(1, 1))
    .toJsonl();
}

describe("planted secrets never surface in output, even when things fail", () => {
  let planted: Planted;
  let savedEnv: NodeJS.ProcessEnv;
  const captured: string[] = [];

  beforeEach(() => {
    planted = plant();
    savedEnv = { ...process.env };
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, planted.env);
    captured.length = 0;
    const take = (...args: unknown[]) => void captured.push(args.map((a) => (typeof a === "string" ? a : inspect(a, { depth: null }))).join(" "));
    for (const m of ["log", "info", "warn", "error", "debug", "trace"] as const) vi.spyOn(console, m).mockImplementation(take);
    for (const stream of [process.stdout, process.stderr]) vi.spyOn(stream, "write").mockImplementation(((chunk: unknown) => (take(String(chunk)), true)) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, savedEnv);
  });

  const machine = () => ({ homeDir: planted.home, username: "tester", hostname: "box" });
  const extra = () => [knownSecret(planted.secrets.SECRETS_FILE, "ACME_SECRET", "secrets-file")];
  /** Everything a caller could dump: reports, the browse review, the prepared object, and what was written to the console. */
  const everything = (prepared: ReturnType<typeof prepareShare>) =>
    [
      formatReport(prepared.report, { maxFindings: Infinity }),
      JSON.stringify(prepared.report),
      JSON.stringify(summarizeShare(prepared)),
      inspect(prepared.report, { depth: null }),
      ...captured,
    ].join("\n");

  it("the planted sources are all really harvested (so the other tests mean something)", () => {
    const found = collectKnownSecrets({ home: planted.home, projectDir: planted.project, enabled: ALL_SOURCES }).secrets;
    for (const [name, value] of Object.entries(planted.secrets)) {
      if (name === "SECRETS_FILE") continue;
      expect(
        found.some((k) => k.value.equals(value)),
        name,
      ).toBe(true);
    }
  });

  it("dumping the collected secrets, a Redactor holding them and the prepare options prints no value", () => {
    const found = [...collectKnownSecrets({ home: planted.home, projectDir: planted.project, enabled: ALL_SOURCES }).secrets, ...extra()];
    expect(found.length).toBe(planted.values.length);
    const redactor = new Redactor({ ...machine(), knownSecrets: found });
    const options = { mode: "full", config: ALL_ON, knownSecrets: found };
    const dumps = [
      JSON.stringify(found),
      inspect(found, { depth: null, showHidden: true }),
      format("%j %o", found, found),
      JSON.stringify(redactor),
      inspect(redactor, { depth: null, showHidden: true }),
      JSON.stringify(options),
      inspect(options, { depth: null, showHidden: true }),
      String(new Error(`bad options: ${inspect(options, { depth: null })}`).stack),
    ];
    console.error("state:", found, redactor, options);
    for (const text of [...dumps, ...captured]) expect(leaks(text, planted)).toEqual([]);
  });

  it("a clean run: the secrets are redacted and appear nowhere in the payload, report or console", () => {
    const prepared = prepareShare(dumpTranscript(planted), { mode: "full", config: ALL_ON, machine: machine(), extraKnownSecrets: extra() });
    expect(prepared.report.knownSources.map((u) => [u.id, u.count])).toEqual([["env", 1], ["projectEnv", 1], ["credentialFiles", 5], ["ghToken", 1], ["secrets-file", 1]]);
    expect(prepared.report.blocked).toBe(false);
    expect(leaks(prepared.json, planted)).toEqual([]);
    expect(prepared.json).toContain("[REDACTED:MY_SERVICE_API_KEY]");
    expect(leaks(everything(prepared), planted)).toEqual([]);
  });

  it("rescan block: a planted value left in the payload is reported by label and length only", () => {
    const leakyKey = planted.secrets.DB_PASSWORD; // object keys are not redacted, so only the re-scan sees this
    const raw = dumpTranscript(planted, { toolInput: { command: "run", [leakyKey]: 1 } });
    const prepared = prepareShare(raw, { mode: "full", config: ALL_ON, machine: machine(), extraKnownSecrets: extra() });
    expect(prepared.report.blocked).toBe(true);
    expect(prepared.report.rescan[0]).toMatchObject({ rule: "known-secret:DB_PASSWORD", length: leakyKey.length });
    // The payload is the thing that is blocked; what a caller may print is everything else.
    expect(leaks(everything(prepared), planted)).toEqual([]);
    const { issues } = rescanPayload(prepared.json, { knownSecrets: [...collectKnownSecrets({ home: planted.home, projectDir: planted.project, enabled: ALL_SOURCES }).secrets] });
    expect(leaks(JSON.stringify(issues) + inspect(issues, { depth: null }), planted)).toEqual([]);
  });

  it("malformed transcripts: neither the thrown errors nor the output of tolerated ones carry a planted value", () => {
    const garbage = [
      `this is not a transcript ${planted.secrets.DB_PASSWORD}`,
      `{"type":"user","sessionId":"x","message":"${planted.secrets.MY_SERVICE_API_KEY}"`, // torn line
      JSON.stringify({ type: "user", sessionId: "s", uuid: "u", cwd: planted.project, message: { content: [{ type: "tool_result", tool_use_id: planted.secrets.GH_TOKEN, content: { weird: planted.secrets.npmrc } }, null, 7] } }),
      JSON.stringify({ type: "assistant", uuid: "a", parentUuid: "u", message: { content: [{ type: "tool_use", id: planted.secrets.netrc, name: { n: planted.secrets.netrc }, input: planted.secrets.SECRETS_FILE }] } }),
    ];
    // Only `prepareShare` is inside the try: an assertion in there would be swallowed by the catch and a leak would pass.
    // Valid sessions with junk or a torn last line are tolerated rather than rejected, so the output side is exercised too.
    const valid = dumpTranscript(planted);
    const inputs = [garbage[0], garbage[1], garbage.join("\n"), garbage.slice(2).join("\n"), `${valid}${garbage[0]}\n`, `${valid}${garbage[1]}`];
    const outcomes = inputs.map((raw) => {
      try {
        return { prepared: prepareShare(raw ?? "", { mode: "full", config: ALL_ON, machine: machine(), extraKnownSecrets: extra() }) };
      } catch (error) {
        return { error: error as Error };
      }
    });
    const errors = outcomes.flatMap((o) => (o.error ? [o.error] : []));
    // Both branches must run, or one of the leak checks below is dead code.
    expect(errors.length).toBeGreaterThan(0);
    expect(outcomes.some((o) => o.prepared)).toBe(true);
    for (const o of outcomes) {
      if (o.prepared) expect(leaks(everything(o.prepared), planted)).toEqual([]);
    }
    for (const err of errors) expect(leaks(`${err.name}: ${err.message}\n${err.stack ?? ""}\n${inspect(err, { depth: null })}`, planted), err.message).toEqual([]);
    expect(leaks(captured.join("\n"), planted)).toEqual([]);
  });

  it("a failing publisher: the error and everything it was handed print no planted value", async () => {
    const prepared = prepareShare(dumpTranscript(planted), { mode: "full", config: ALL_ON, machine: machine(), extraKnownSecrets: extra() });
    const found = [...collectKnownSecrets({ home: planted.home, projectDir: planted.project, enabled: ALL_SOURCES }).secrets, ...extra()];

    // The real gist publisher with a runner that fails like `gh` does.
    const real = new GistPublisher({ viewerUrl: "https://viewer.invalid", run: async (_cmd, args) => (args[0] === "auth" ? { code: 0, stdout: "", stderr: "" } : { code: 1, stdout: "", stderr: "HTTP 502" }) });
    // A sloppy one that builds its error message from everything in reach, the way a hurried debug print would.
    const sloppy: Publisher = {
      name: "sloppy",
      async publish(payload: PublishPayload) {
        throw new Error(`upload failed: ${inspect({ payload: { ...payload, content: payload.content.length }, found, report: prepared.report }, { depth: null })} ${JSON.stringify(found)}`);
      },
      async delete() {},
    };
    for (const publisher of [real, sloppy]) {
      const err = await publishPrepared(publisher, ALL_ON, "gist", prepared).then(
        () => undefined,
        (e: Error) => e,
      );
      expect(err, publisher.name).toBeInstanceOf(Error);
      if (publisher === real) expect(err?.message).toContain("HTTP 502");
      expect(leaks(`${err?.message}\n${err?.stack}`, planted), publisher.name).toEqual([]);
      console.error(`agent-share: ${err?.message}`);
    }
    expect(leaks(captured.join("\n"), planted)).toEqual([]);
  });
});

describe("the CLI never prints planted values, including on failure", () => {
  const cli = (p: Planted, args: string[], file: string) => {
    const r = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), join(root, "src", "cli.ts"), ...args, file], {
      encoding: "utf8",
      cwd: p.project,
      env: { ...p.env, HOME: p.home, XDG_CONFIG_HOME: join(p.home, ".config"), NO_COLOR: "1" },
      input: "",
    });
    return { status: r.status, text: [r.stdout, r.stderr].join("\n") };
  };
  const write = (p: Planted, raw: string) => {
    const file = join(mkdtempSync(join(tmpdir(), "as-leakcli-")), "s.jsonl");
    writeFileSync(file, raw);
    return file;
  };

  it("report, blocked report, failed publish and malformed transcript", { timeout: 60_000 }, () => {
    const p = plant();
    mkdirSync(join(p.home, ".config", "agent-share"), { recursive: true });
    writeFileSync(join(p.home, ".config", "agent-share", "config.json"), JSON.stringify({ redact: { knownSources: ALL_SOURCES } }));

    const clean = cli(p, ["report", "--mode", "full", "--json"], write(p, dumpTranscript(p)));
    expect(clean.status).toBe(2); // redacted something, needs review
    expect(JSON.parse(clean.text.slice(clean.text.indexOf("{"))).knownSources.reduce((n: number, u: { count: number }) => n + u.count, 0)).toBeGreaterThanOrEqual(8);

    const blocked = cli(p, ["report", "--mode", "full"], write(p, dumpTranscript(p, { toolInput: { command: "run", [p.secrets.DB_PASSWORD]: 1 } })));
    expect(blocked.status).toBe(3);
    expect(blocked.text).toContain("known-secret:DB_PASSWORD");

    // `gh auth status` passes and `gh gist create` fails (see the fake `gh`), after the report is shown.
    const failedPublish = cli(p, ["publish", "--mode", "full", "--yes", "--allow-findings", "--target", "gist"], write(p, dumpTranscript(p)));
    expect(failedPublish.status).toBe(1);
    expect(failedPublish.text).toContain("gh gist create failed");

    const malformed = cli(p, ["report", "--mode", "full"], write(p, `not json at all ${p.secrets.DB_PASSWORD}\n{"type":"user"`));
    // The torn/garbage lines are tolerated, so this is a (nearly empty) session rather than an error; either way nothing is echoed.
    expect(malformed.text.length).toBeGreaterThan(0);

    for (const [name, out] of Object.entries({ clean, blocked, failedPublish, malformed })) expect(leaks(out.text, p), name).toEqual([]);
  });
});
