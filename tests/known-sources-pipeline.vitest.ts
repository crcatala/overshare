/**
 * The real pipeline (collector, redactor, re-scan, report, CLI) with fake secrets planted in every harvesting
 * source and a fake `gh` on PATH. Planted values match no secret pattern, so only the known-values layer can
 * catch them: a value that survives into the payload is a value the pattern layers did not see.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { summarizeShare } from "../src/browse/job.js";
import { DEFAULT_CONFIG, type AgentShareConfig } from "../src/config.js";
import { prepareShare } from "../src/pipeline.js";
import { knownSecret } from "../src/redact/known-values.js";
import { formatKnownSources, formatReport } from "../src/report.js";
import { ClaudeTranscript, ccUsage, randomish } from "./helpers.js";

const root = join(import.meta.dirname, "..");
const v = (seed: number) => `Q${randomish(33, seed)}`;

function plant() {
  const home = mkdtempSync(join(tmpdir(), "as-ksp-home-"));
  const project = mkdtempSync(join(tmpdir(), "as-ksp-proj-"));
  const bin = mkdtempSync(join(tmpdir(), "as-ksp-bin-"));
  const secrets = { MY_SERVICE_API_KEY: v(301), DB_PASSWORD: v(302), credentialJson: v(303), hostsYml: v(304), npmrc: v(305), netrc: v(306), ghToken: v(307) };
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(join(home, ".config", "gh"), { recursive: true });
  writeFileSync(join(home, ".claude", ".credentials.json"), JSON.stringify({ claudeAiOauth: { access: secrets.credentialJson } }));
  writeFileSync(join(home, ".config", "gh", "hosts.yml"), `github.com:\n    oauth_token: ${secrets.hostsYml}\n`);
  writeFileSync(join(home, ".npmrc"), `//registry.npmjs.org/:_authToken=${secrets.npmrc}\n`);
  writeFileSync(join(home, ".netrc"), `machine example.invalid login me password ${secrets.netrc}\n`);
  writeFileSync(join(project, ".env"), `DB_PASSWORD=${secrets.DB_PASSWORD}\n`);
  // A fake `gh` that leaves a marker when asked for a token, so "never called" is observable.
  const marker = join(bin, "gh-token-called");
  const gh = join(bin, "gh");
  writeFileSync(gh, `#!/bin/sh\nif [ "$1" = auth ] && [ "$2" = token ]; then touch ${marker}; echo ${secrets.ghToken}; exit 0; fi\nexit 1\n`);
  chmodSync(gh, 0o755);
  return { home, project, bin, marker, secrets, env: { PATH: `${bin}:/usr/bin:/bin`, CLAUDE_CONFIG_DIR: join(home, ".claude"), MY_SERVICE_API_KEY: secrets.MY_SERVICE_API_KEY } };
}
type Planted = ReturnType<typeof plant>;

/** A session in which the agent printed every planted value. No `NAME=` before it, so no assignment heuristic can catch it. */
function dump(p: Planted) {
  return new ClaudeTranscript("cccccccc-0000-0000-0000-000000000000", p.project)
    .user("show me the config")
    .assistant("m1", [{ type: "tool_use", id: "b1", name: "Bash", input: { command: "cat .env; printenv; cat ~/.npmrc" } }], ccUsage(1, 1))
    .toolResult("b1", Object.values(p.secrets).map((value) => `the value is ${value} ok`).join("\n"))
    .assistant("m2", [{ type: "text", text: "done" }], ccUsage(1, 1))
    .toJsonl();
}

const withSources = (knownSources: Partial<AgentShareConfig["redact"]["knownSources"]>): AgentShareConfig => ({
  ...DEFAULT_CONFIG,
  redact: { ...DEFAULT_CONFIG.redact, knownSources: { ...DEFAULT_CONFIG.redact.knownSources, ...knownSources } },
});

describe("harvesting through the real pipeline", () => {
  let p: Planted;
  let saved: NodeJS.ProcessEnv;
  beforeEach(() => {
    p = plant();
    saved = { ...process.env };
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, p.env);
  });
  afterEach(() => {
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, saved);
  });
  const run = (config: AgentShareConfig) => prepareShare(dump(p), { mode: "full", config, machine: { homeDir: p.home, username: "tester", hostname: "box" } });
  const survivors = (json: string) => Object.entries(p.secrets).filter(([, value]) => json.includes(value)).map(([name]) => name);

  it("by default redacts the planted env var and .env value, and calls gh for nothing", () => {
    const { json, report } = run(DEFAULT_CONFIG);
    expect(json).toContain("[REDACTED:MY_SERVICE_API_KEY]");
    expect(json).toContain("[REDACTED:DB_PASSWORD]");
    expect(existsSync(p.marker)).toBe(false);
    expect(report.knownSources).toEqual([
      { id: "env", enabled: true, count: 1 },
      { id: "projectEnv", enabled: true, count: 1 },
      { id: "credentialFiles", enabled: false, count: 0 },
      { id: "ghToken", enabled: false, count: 0 },
    ]);
  });

  it("by default the opt-in sources are NOT harvested: this is the documented gap (no pattern matches these fake values)", () => {
    // If a pattern layer caught one of these it would not be listed, so this documents what the tool cannot see when sources are off.
    const { json, report } = run(DEFAULT_CONFIG);
    expect(survivors(json).sort()).toEqual(["credentialJson", "ghToken", "hostsYml", "netrc", "npmrc"]);
    expect(report.blocked).toBe(false); // nothing in the final re-scan knows these values either
  });

  it("credentialFiles on: the JSON, hosts.yml, .npmrc and .netrc values are redacted; the gh token still is not", () => {
    const { json, report } = run(withSources({ credentialFiles: true }));
    expect(survivors(json)).toEqual(["ghToken"]);
    expect(existsSync(p.marker)).toBe(false);
    expect(report.knownSources.find((u) => u.id === "credentialFiles")).toEqual({ id: "credentialFiles", enabled: true, count: 4 });
  });

  it("ghToken on: gh is asked once for the token and that value is redacted; credential files stay unread", () => {
    const { json, report } = run(withSources({ ghToken: true }));
    expect(existsSync(p.marker)).toBe(true);
    expect(survivors(json).sort()).toEqual(["credentialJson", "hostsYml", "netrc", "npmrc"]);
    expect(report.knownSources.find((u) => u.id === "ghToken")).toEqual({ id: "ghToken", enabled: true, count: 1 });
  });

  it("env and projectEnv can be switched off too", () => {
    const { json } = run(withSources({ env: false, projectEnv: false }));
    expect(survivors(json)).toContain("MY_SERVICE_API_KEY");
    expect(survivors(json)).toContain("DB_PASSWORD");
  });

  it("everything on redacts every planted value", () => {
    const { json } = run(withSources({ credentialFiles: true, ghToken: true }));
    expect(survivors(json)).toEqual([]);
  });

  it("the human report, --json report and browse review list consulted and not-consulted sources, with counts and no values", () => {
    const prepared = run(DEFAULT_CONFIG);
    const human = formatReport(prepared.report);
    expect(human).toContain("Known values: env (1), project .env (1); not read: credential files, gh auth token (disabled)");
    const surfaces = [human, JSON.stringify(prepared.report), JSON.stringify(summarizeShare(prepared))];
    for (const text of surfaces) for (const value of Object.values(p.secrets)) expect(text).not.toContain(value.slice(0, 8));
    expect(summarizeShare(prepared).knownSources).toEqual(prepared.report.knownSources);
  });

  it("lists --secrets-file values as their own source and redacts them", () => {
    const declared = v(310);
    const raw = new ClaudeTranscript("dddddddd-0000-0000-0000-000000000000", p.project).user(`remember ${declared} please`).assistant("m1", [{ type: "text", text: "ok" }], ccUsage(1, 1)).toJsonl();
    const prepared = prepareShare(raw, { mode: "full", config: DEFAULT_CONFIG, machine: { homeDir: p.home, username: "tester", hostname: "box" }, extraKnownSecrets: [knownSecret(declared, "ACME", "secrets-file")] });
    expect(prepared.report.knownSources.at(-1)).toEqual({ id: "secrets-file", enabled: true, count: 1 });
    expect(prepared.json).not.toContain(declared);
  });
});

describe("formatKnownSources", () => {
  it("names consulted sources with counts, then the sources that were not read", () => {
    expect(
      formatKnownSources([
        { id: "env", enabled: true, count: 4 },
        { id: "projectEnv", enabled: true, count: 2 },
        { id: "credentialFiles", enabled: false, count: 0 },
        { id: "ghToken", enabled: true, count: 1 },
        { id: "secrets-file", enabled: true, count: 3 },
      ]),
    ).toBe("env (4), project .env (2), gh auth token (1), secrets file (3); not read: credential files (disabled)");
    expect(formatKnownSources([{ id: "env", enabled: false, count: 0 }])).toBe("none; not read: env (disabled)");
  });
});

describe("the CLI", () => {
  it("honours redact.knownSources from the config file and reports it in --json", { timeout: 60_000 }, () => {
    const p = plant();
    const dir = mkdtempSync(join(tmpdir(), "as-ksp-cli-"));
    const file = join(dir, "s.jsonl");
    writeFileSync(file, dump(p));
    const cli = (config: unknown) => {
      const configFile = join(dir, "config.json");
      writeFileSync(configFile, JSON.stringify(config));
      const r = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), join(root, "src", "cli.ts"), "report", "--mode", "full", "--json", file], {
        encoding: "utf8",
        cwd: p.project,
        env: { ...p.env, HOME: p.home, AGENT_SHARE_CONFIG: configFile, NO_COLOR: "1" },
        input: "",
      });
      return { text: [r.stdout, r.stderr].join("\n"), report: JSON.parse(r.stdout) as { knownSources: Array<{ id: string; enabled: boolean; count: number }> } };
    };
    const byDefault = cli({});
    expect(byDefault.report.knownSources.map((u) => [u.id, u.enabled, u.count])).toEqual([["env", true, 1], ["projectEnv", true, 1], ["credentialFiles", false, 0], ["ghToken", false, 0]]);
    expect(existsSync(p.marker)).toBe(false);
    const optedIn = cli({ redact: { knownSources: { credentialFiles: true, ghToken: true } } });
    expect(optedIn.report.knownSources.map((u) => [u.id, u.enabled, u.count])).toEqual([["env", true, 1], ["projectEnv", true, 1], ["credentialFiles", true, 4], ["ghToken", true, 1]]);
    expect(existsSync(p.marker)).toBe(true);
    for (const out of [byDefault, optedIn]) for (const value of Object.values(p.secrets)) expect(out.text).not.toContain(value);
  });
});
