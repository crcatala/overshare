import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.js";
import { exampleShare, exportFixtureShares, generateFixtures } from "../src/fixtures/index.js";
import { prepareShare } from "../src/pipeline.js";
import { readSecretsFile } from "../src/redact/known-values.js";
import { listSessions } from "../src/resolve.js";
import { readSession } from "../src/harnesses/index.js";
import { SCHEMA_VERSION, SHARE_MODES } from "../src/schema.js";

const home = "/home/fixture-user";
const codexIdOf = (file: string) => /([0-9a-f-]{36})\.jsonl$/.exec(file)![1]!;
const machine = { homeDir: home, username: "fixture-user" };

function generate(seed = 3) {
  return generateFixtures({ outDir: mkdtempSync(join(tmpdir(), "as-fx-")), seed, home, username: "fixture-user" });
}

describe("fixture generator", () => {
  const fx = generate();
  const extra = readSecretsFile(fx.secretsFile);
  const files = [
    ["claude-code", fx.claudeFile],
    ["pi", fx.piFile],
  ] as const;

  it("is deterministic per seed", () => {
    const again = generate();
    expect(readFileSync(again.claudeFile, "utf8")).toBe(readFileSync(fx.claudeFile, "utf8"));
    expect(readFileSync(again.piFile, "utf8")).toBe(readFileSync(fx.piFile, "utf8"));
    expect(readFileSync(generate(4).piFile, "utf8")).not.toBe(readFileSync(fx.piFile, "utf8"));
  });

  it("lays files out like the real harness directories", () => {
    expect(listSessions("claude-code", fx.roots).map((r) => r.path)).toEqual([fx.claudeFile]);
    expect(listSessions("pi", fx.roots).map((r) => r.path)).toEqual([fx.piFile]);
  });

  for (const [harness, file] of files) {
    describe(harness, () => {
      const raw = readFileSync(file, "utf8");

      it("plants every secret in the raw transcript", () => {
        for (const s of fx.secrets) expect(raw, s.label).toContain(s.value.split("\n")[1] ?? s.value);
      });

      for (const mode of SHARE_MODES) {
        it(`${mode}: leaks no planted secret, home path or abandoned branch`, () => {
          const { json, report } = prepareShare(raw, { mode, config: DEFAULT_CONFIG, harness, machine, knownSecrets: [], extraKnownSecrets: extra });
          expect(report.blocked).toBe(false);
          for (const s of fx.secrets) for (const line of s.value.split("\n")) if (line.length > 20) expect(json, s.label).not.toContain(line);
          expect(json).not.toContain(home);
          expect(json).not.toContain(fx.abandonedMarker);
        });
      }

      it("full mode is caught by patterns alone except the format-less internal token", () => {
        const { json, report } = prepareShare(raw, { mode: "full", config: DEFAULT_CONFIG, harness, machine, knownSecrets: [] });
        expect(report.clean).toBe(false);
        for (const s of fx.secrets) {
          const leaked = s.value.split("\n").some((line) => line.length > 20 && json.includes(line));
          expect(leaked, s.label).toBe(s.caughtBy === "secrets-file");
        }
      });

      it("brief mode drops the env dump and reports clean", () => {
        const { json, report } = prepareShare(raw, { mode: "brief", config: DEFAULT_CONFIG, harness, machine, knownSecrets: [], extraKnownSecrets: extra });
        expect(report.clean).toBe(true);
        expect(json).not.toContain("SLACK_BOT_TOKEN");
      });

      it("prompts exports retain counts/usage but no work or expanded prompts", () => {
        const opts = { config: DEFAULT_CONFIG, harness, machine, knownSecrets: [], extraKnownSecrets: extra };
        const full = prepareShare(raw, { ...opts, mode: "full" }).session;
        const prompts = prepareShare(raw, { ...opts, mode: "prompts" }).session;
        expect(prompts.turns).toHaveLength(full.turns.length);
        expect(prompts.stats).toEqual(full.stats);
        expect(prompts.responses).toEqual(full.responses);
        expect(prompts.turns.every((t) => t.steps.length === 0 && !t.user?.expanded)).toBe(true);
        expect(prompts.turns.reduce((sum, t) => sum + t.activity!.toolCalls, 0)).toBe(full.stats.toolCalls);
        expect(prompts.turns[3]!.user?.text).toBe("/review src/invoices");
        const expansion = "Delegate a deep read of related modules to a subagent, then summarise findings as a table.";
        expect(raw).toContain(expansion); // The fixture actually contains the expansion.
        expect(JSON.stringify(prompts.turns.map((t) => t.user))).not.toContain(expansion);
        for (const mode of ["brief", "minimal", "prompts"] as const) {
          expect(prepareShare(raw, { ...opts, mode }).json).not.toContain(expansion);
        }
        const json = JSON.stringify(prompts.turns.map((t) => t.activity));
        expect(json).not.toMatch(/"(?:text|commands|agents|description|input|result|detail|expanded)"/);
      });

      it("exercises the features the viewer renders", () => {
        const { session } = prepareShare(raw, { mode: "full", config: DEFAULT_CONFIG, harness, machine, knownSecrets: [], extraKnownSecrets: extra });
        const steps = session.turns.flatMap((t) => t.steps);
        const events = new Set(steps.flatMap((s) => (s.kind === "event" ? [s.event] : [])));
        expect(session.stats).toMatchObject({ turns: 8, subagents: 1 });
        expect(session.stats.toolErrors).toBeGreaterThanOrEqual(1);
        expect(session.stats.compactions).toBeGreaterThanOrEqual(1);
        expect(session.responses.length).toBeGreaterThan(10);
        expect(session.stats.cost).toBeGreaterThan(0);
        expect(steps.some((s) => s.kind === "tool" && s.result?.truncatedFrom)).toBe(true);
        expect(steps.some((s) => s.kind === "tool" && s.result?.images)).toBe(true);
        expect(session.turns.some((t) => t.user?.images)).toBe(true);
        for (const e of ["interrupted", "error", "compaction"] as const) expect(events.has(e), e).toBe(true);
        // A skill the model loaded and one the user typed.
        expect(steps.flatMap((s) => (s.kind === "event" && s.skill ? [s.skill] : []))).toEqual([
          { name: "code-review", invokedBy: "model" },
          { name: "ship-pr", invokedBy: "user" },
        ]);
        // The demo shows each kind of cache event: an idle-gap miss, the rebuild after the compaction and (pi) a model switch.
        const cache = session.responses.flatMap((r) => (r.cacheEvent ? [r.cacheEvent] : []));
        expect(cache.find((e) => e.kind === "miss")).toMatchObject({ idle: true, gapMs: expect.any(Number) });
        expect(cache.find((e) => e.kind === "rebuild")).toBeDefined();
        expect(cache.some((e) => e.kind === "model-switch")).toBe(harness === "pi");
        expect(session.stats.cache).toMatchObject({ misses: 1, rebuilds: 1, modelSwitches: harness === "pi" ? 1 : 0 });
        if (harness === "claude-code") {
          for (const e of ["command", "skill"] as const) expect(events.has(e), e).toBe(true);
          expect(session.turns.some((t) => t.user?.command?.name === "/review")).toBe(true);
        } else {
          for (const e of ["model_change", "thinking_level", "subagent_notice"] as const) expect(events.has(e), e).toBe(true);
          expect(steps.some((s) => s.kind === "thinking" && s.text)).toBe(true);
        }
      });
    });
  }

  describe("codex and antigravity", () => {
    const more = [
      ["codex", fx.codexFile],
      ["antigravity", fx.antigravityFile],
    ] as const;

    it("are deterministic per seed, laid out like the real folders, and listed", () => {
      const again = generate();
      expect(readFileSync(again.codexFile, "utf8")).toBe(readFileSync(fx.codexFile, "utf8"));
      expect(readFileSync(again.antigravityFile, "utf8")).toBe(readFileSync(fx.antigravityFile, "utf8"));
      expect(listSessions("codex", fx.roots).map((r) => r.path)).toEqual([fx.codexFile]);
      expect(listSessions("antigravity", fx.roots).map((r) => r.path)).toEqual([fx.antigravityFile]);
    });

    it("can be generated again into the same folder, with another seed beside them", () => {
      const out = mkdtempSync(join(tmpdir(), "as-fx-again-"));
      const first = generateFixtures({ outDir: out, seed: 3, home, username: "fixture-user" });
      const again = generateFixtures({ outDir: out, seed: 3, home, username: "fixture-user" });
      expect(readFileSync(again.antigravityFile, "utf8")).toBe(readFileSync(first.antigravityFile, "utf8"));
      expect(readSession("antigravity", again.antigravityFile).options.sidecar).toMatchObject({ workspaces: [expect.objectContaining({ branch: "fix/invoice-currency" })] });
      const other = generateFixtures({ outDir: out, seed: 4, home, username: "fixture-user" });
      const titles = readFileSync(join(out, "codex", "session_index.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l).id as string);
      expect(titles.sort()).toEqual([codexIdOf(first.codexFile), codexIdOf(other.codexFile)].sort());
    });

    it("keeps the story's order in the Codex session: a command never runs ahead of an edit made before it", () => {
      const { session } = prepareShare(readFileSync(fx.codexFile, "utf8"), { mode: "full", config: DEFAULT_CONFIG, harness: "codex", machine, knownSecrets: [] });
      const steps = session.turns.flatMap((t) => t.steps).filter((s) => s.kind === "tool");
      const written = steps.findIndex((s) => s.kind === "tool" && s.action === "write" && s.summary.includes("currency.test.ts"));
      const run = steps.findIndex((s) => s.kind === "tool" && s.summary.includes("npm test -- src/invoices/currency.test.ts"));
      expect(written).toBeGreaterThanOrEqual(0);
      expect(run).toBeGreaterThan(written);
    });

    for (const [harness, file] of more) {
      const { raw, options } = readSession(harness, file);
      const opts = { config: DEFAULT_CONFIG, harness, machine, knownSecrets: [], extraKnownSecrets: extra, ...options };

      for (const mode of SHARE_MODES) {
        it(`${harness} ${mode}: leaks no planted secret, home path or abandoned branch`, () => {
          const { json, report } = prepareShare(raw, { ...opts, mode });
          expect(report.blocked).toBe(false);
          for (const s of fx.secrets) for (const line of s.value.split("\n")) if (line.length > 20) expect(json, s.label).not.toContain(line);
          expect(json).not.toContain(home);
          expect(json).not.toContain(fx.abandonedMarker);
          expect(json).not.toMatch(/gAAAA/);
        });
      }

      it(`${harness}: exercises what the viewer renders`, () => {
        const { session } = prepareShare(raw, { ...opts, mode: "full" });
        const steps = session.turns.flatMap((t) => t.steps);
        const events = new Set(steps.flatMap((s) => (s.kind === "event" ? [s.event] : [])));
        expect(session.title).toBeTruthy();
        expect(session.project).toMatchObject({ name: "acme-billing-api", branch: "fix/invoice-currency" });
        expect(session.stats.toolCalls).toBeGreaterThan(5);
        expect(session.stats.cost).toBeGreaterThan(0);
        expect(session.stats.costSource).toBe("estimated");
        expect(session.turns.every((t) => !t.user || t.user.authored)).toBe(true);
        expect(session.turns.some((t) => t.user?.images)).toBe(true);
        expect(steps.some((s) => s.kind === "thinking" && s.text)).toBe(true);
        expect(steps.some((s) => s.kind === "tool" && s.action === "edit")).toBe(true);
        for (const e of ["error", "compaction", "model_change"] as const) expect(events.has(e), e).toBe(true);
        // The scripted API error itself, not only some error.
        expect(steps.some((s) => s.kind === "event" && s.event === "error" && /529/.test(s.text))).toBe(true);
        expect(session.stats.cache?.rebuilds).toBeGreaterThanOrEqual(1);
        if (harness === "codex") {
          // Antigravity's results carry no exit status; Codex's commands do.
          expect(session.stats.toolErrors).toBeGreaterThanOrEqual(1);
          expect(session.stats.subagents).toBe(1);
          expect(events.has("interrupted")).toBe(true);
          expect(steps.some((s) => s.kind === "event" && s.skill?.invokedBy === "user")).toBe(true);
        } else {
          expect(events.has("notification")).toBe(true);
          expect(steps.filter((s) => s.kind === "tool").every((s) => s.kind === "tool" && s.result)).toBe(true);
        }
      });
    }
  });

  it("refuses historical pi fixture prompts exports instead of leaking the expanded review template", () => {
    const legacy = generateFixtures({ outDir: mkdtempSync(join(tmpdir(), "as-legacy-pi-")), seed: 3, home, username: "fixture-user", piInputProvenance: false });
    const raw = readFileSync(legacy.piFile, "utf8");
    expect(raw).toContain("Delegate a deep read of related modules to a subagent");
    const opts = { config: DEFAULT_CONFIG, harness: "pi" as const, machine, knownSecrets: [] };
    expect(() => prepareShare(raw, { ...opts, mode: "prompts" })).toThrow(/no verified pre-expansion input/);
    // Other modes retain historical stored text: no invented slash-command reconstruction.
    const brief = prepareShare(raw, { ...opts, mode: "brief" }).session;
    expect(brief.turns[3]!.user).toMatchObject({ text: expect.stringContaining("Delegate a deep read"), authored: false });
  });

  it("scales with extra turns", () => {
    const big = generateFixtures({ outDir: mkdtempSync(join(tmpdir(), "as-fx-")), seed: 5, extraTurns: 20, home, username: "fixture-user" });
    const { session } = prepareShare(readFileSync(big.claudeFile, "utf8"), { mode: "brief", config: DEFAULT_CONFIG, harness: "claude-code", machine, knownSecrets: [] });
    expect(session.stats.turns).toBe(28);
  });
});

describe("example share (the landing page's demo session)", () => {
  const now = new Date("2026-10-01T12:00:00Z");
  const { json, report } = exampleShare({ now });
  const share = JSON.parse(json);
  // The same transcript exampleShare generates: seed 1, fixed home and user.
  const planted = generateFixtures({ outDir: mkdtempSync(join(tmpdir(), "as-fx-")), home: "/home/dana", username: "dana" }).secrets;

  it("is a full Claude Code share the viewer opens, so readers can step down to every other mode", () => {
    expect(share.schema).toBe(SCHEMA_VERSION);
    expect(share.mode).toBe("full");
    expect(share.harness.name).toBe("claude-code");
    expect(report.blocked).toBe(false);
  });

  it("shows redaction at work: the planted fake secrets are replaced, never published", () => {
    expect(planted.length).toBeGreaterThan(0);
    expect(json).toMatch(/\[REDACTED:[A-Z_]+\]/);
    for (const secret of planted) expect(json).not.toContain(secret.value);
    expect(json).not.toContain("/home/dana");
  });

  it("comes out the same on every build (fixed home, user and config)", () => {
    expect(exampleShare({ now }).json).toBe(json);
  });
});
