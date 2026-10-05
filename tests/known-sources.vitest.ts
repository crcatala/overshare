/**
 * Machine-secret harvesting is opt-in per source. These tests spy on the collector's own file reads and
 * its `gh auth token` call (the only things that touch credentials) and assert what happens by default
 * and when each source is switched on. Values are obviously fake and match no secret pattern.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const spies = vi.hoisted(() => ({ reads: [] as string[], listed: [] as string[], exec: [] as Array<[string, string[]]> }));

vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  return {
    ...real,
    readFileSync: ((path: string, ...rest: unknown[]) => (spies.reads.push(String(path)), (real.readFileSync as (...a: unknown[]) => unknown)(path, ...rest))) as typeof real.readFileSync,
    readdirSync: ((path: string, ...rest: unknown[]) => (spies.listed.push(String(path)), (real.readdirSync as (...a: unknown[]) => unknown)(path, ...rest))) as typeof real.readdirSync,
  };
});
vi.mock("node:child_process", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:child_process")>();
  return { ...real, execFileSync: ((cmd: string, args: string[]) => (spies.exec.push([cmd, args]), `${PLANTED.ghToken}\n`)) as unknown as typeof real.execFileSync };
});

const { DEFAULT_KNOWN_SOURCES, collectKnownSecrets, KNOWN_SOURCES } = await import("../src/redact/known-values.js");
const { DEFAULT_CONFIG, loadConfig } = await import("../src/config.js");
const { randomish } = await import("./helpers.js");

const PLANTED = {
  env: `Qenv${randomish(30, 201)}`,
  projectEnv: `Qproj${randomish(30, 202)}`,
  piJson: `Qpi${randomish(30, 203)}`,
  claudeJson: `Qclaude${randomish(30, 204)}`,
  codexJson: `Qcodex${randomish(30, 205)}`,
  ghHosts: `Qhosts${randomish(30, 206)}`,
  npmrc: `Qnpm${randomish(30, 207)}`,
  netrc: `Qnet${randomish(30, 208)}`,
  ghToken: `Qghtok${randomish(30, 209)}`,
};

function machine() {
  const home = mkdtempSync(join(tmpdir(), "as-ks-home-"));
  const project = mkdtempSync(join(tmpdir(), "as-ks-proj-"));
  for (const dir of [".pi/agent", ".claude", ".codex", ".config/gh"]) mkdirSync(join(home, dir), { recursive: true });
  writeFileSync(join(home, ".pi/agent/auth.json"), JSON.stringify({ anthropic: { access: PLANTED.piJson } }));
  writeFileSync(join(home, ".claude/.credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: PLANTED.claudeJson } }));
  writeFileSync(join(home, ".codex/auth.json"), JSON.stringify({ tokens: { id_token: PLANTED.codexJson } }));
  writeFileSync(join(home, ".config/gh/hosts.yml"), `github.com:\n    oauth_token: ${PLANTED.ghHosts}\n`);
  writeFileSync(join(home, ".npmrc"), `//registry.npmjs.org/:_authToken=${PLANTED.npmrc}\n`);
  writeFileSync(join(home, ".netrc"), `machine example.invalid login me password ${PLANTED.netrc}\n`);
  writeFileSync(join(project, ".env"), `DB_PASSWORD=${PLANTED.projectEnv}\n`);
  return { home, project, env: { MY_SERVICE_API_KEY: PLANTED.env } as NodeJS.ProcessEnv };
}

const credentialPaths = (home: string) => [".pi/agent/auth.json", ".claude/.credentials.json", ".codex/auth.json", ".config/gh/hosts.yml", ".npmrc", ".netrc"].map((p) => join(home, p));
const has = (found: ReturnType<typeof collectKnownSecrets>, value: string) => found.secrets.some((k) => k.value.equals(value));
const counts = (found: ReturnType<typeof collectKnownSecrets>) => Object.fromEntries(found.sources.map((u) => [u.id, u.count]));

beforeEach(() => {
  spies.reads.length = 0;
  spies.listed.length = 0;
  spies.exec.length = 0;
});

describe("known-value sources: defaults", () => {
  it("ship env and project .env on, everything that reads a credential store off", () => {
    expect(DEFAULT_KNOWN_SOURCES).toEqual({ env: true, projectEnv: true, credentialFiles: false, ghToken: false });
    expect(DEFAULT_CONFIG.redact.knownSources).toEqual(DEFAULT_KNOWN_SOURCES);
    expect(KNOWN_SOURCES).toEqual(["env", "projectEnv", "credentialFiles", "ghToken"]);
  });

  it("the default collector opens no credential file, ~/.npmrc, ~/.netrc or hosts.yml and never runs gh", () => {
    const m = machine();
    const found = collectKnownSecrets({ home: m.home, env: m.env, projectDir: m.project });
    for (const file of credentialPaths(m.home)) expect(spies.reads, file).not.toContain(file);
    expect(spies.reads).toEqual([join(m.project, ".env")]); // the only file opened is the session project's .env
    expect(spies.exec).toEqual([]);
    // env and project .env still contribute
    expect(has(found, PLANTED.env)).toBe(true);
    expect(has(found, PLANTED.projectEnv)).toBe(true);
    expect(counts(found)).toEqual({ env: 1, projectEnv: 1, credentialFiles: 0, ghToken: 0 });
    for (const value of [PLANTED.piJson, PLANTED.claudeJson, PLANTED.codexJson, PLANTED.ghHosts, PLANTED.npmrc, PLANTED.netrc, PLANTED.ghToken]) expect(has(found, value)).toBe(false);
  });

  it("reports the sources that were not read as disabled", () => {
    const found = collectKnownSecrets({ home: machine().home, env: {} });
    expect(found.sources).toEqual([
      { id: "env", enabled: true, count: 0 },
      { id: "projectEnv", enabled: true, count: 0 },
      { id: "credentialFiles", enabled: false, count: 0 },
      { id: "ghToken", enabled: false, count: 0 },
    ]);
  });
});

describe("known-value sources: opting in", () => {
  it("env off: environment variables are not read", () => {
    const m = machine();
    const found = collectKnownSecrets({ home: m.home, env: m.env, enabled: { env: false } });
    expect(has(found, PLANTED.env)).toBe(false);
    expect(found.secrets).toEqual([]);
  });

  it("projectEnv off: the project directory is not even listed", () => {
    const m = machine();
    const found = collectKnownSecrets({ home: m.home, env: {}, projectDir: m.project, enabled: { projectEnv: false } });
    expect(spies.listed).toEqual([]);
    expect(spies.reads).toEqual([]);
    expect(found.secrets).toEqual([]);
  });

  it("credentialFiles on: exactly the pi/Claude/Codex JSON, hosts.yml, .npmrc and .netrc contribute, and gh is not run", () => {
    const m = machine();
    const found = collectKnownSecrets({ home: m.home, env: {}, enabled: { credentialFiles: true } });
    for (const value of [PLANTED.piJson, PLANTED.claudeJson, PLANTED.codexJson, PLANTED.ghHosts, PLANTED.npmrc, PLANTED.netrc]) expect(has(found, value), value.slice(0, 6)).toBe(true);
    expect(has(found, PLANTED.ghToken)).toBe(false);
    expect(counts(found)).toEqual({ env: 0, projectEnv: 0, credentialFiles: 6, ghToken: 0 });
    for (const file of credentialPaths(m.home)) expect(spies.reads, file).toContain(file);
    expect(spies.exec).toEqual([]);
  });

  it("ghToken on: runs exactly `gh auth token` once and reads no credential file", () => {
    const m = machine();
    const found = collectKnownSecrets({ home: m.home, env: {}, enabled: { ghToken: true } });
    expect(spies.exec).toEqual([["gh", ["auth", "token"]]]);
    expect(has(found, PLANTED.ghToken)).toBe(true);
    expect(counts(found)).toEqual({ env: 0, projectEnv: 0, credentialFiles: 0, ghToken: 1 });
    for (const file of credentialPaths(m.home)) expect(spies.reads, file).not.toContain(file);
  });
});

describe("redact.knownSources config", () => {
  const withConfig = (value: unknown) => {
    const file = join(mkdtempSync(join(tmpdir(), "as-ks-cfg-")), "config.json");
    writeFileSync(file, JSON.stringify(value));
    return () => loadConfig({ OVERSHARE_CONFIG: file });
  };

  it("defaults when unset, and a partial setting only changes the named sources", () => {
    expect(withConfig({})().redact.knownSources).toEqual(DEFAULT_KNOWN_SOURCES);
    expect(withConfig({ redact: { emails: false } })().redact.knownSources).toEqual(DEFAULT_KNOWN_SOURCES);
    expect(withConfig({ redact: { knownSources: { ghToken: true, env: false } } })().redact.knownSources).toEqual({ env: false, projectEnv: true, credentialFiles: false, ghToken: true });
  });

  it("rejects typos and non-booleans instead of silently ignoring a security setting", () => {
    expect(withConfig({ redact: { knownSources: { credentialfiles: true } } })).toThrow(/unknown redact\.knownSources\.credentialfiles/);
    expect(withConfig({ redact: { knownSources: { ghToken: "yes" } } })).toThrow(/knownSources\.ghToken must be true or false/);
    expect(withConfig({ redact: { knownSources: ["env"] } })).toThrow(/must be an object of booleans/);
  });
});
