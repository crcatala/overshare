import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.js";
import { generateFixtures } from "../src/fixtures/index.js";
import { prepareShare } from "../src/pipeline.js";
import { readSecretsFile } from "../src/redact/known-values.js";
import { listSessions } from "../src/resolve.js";
import { SHARE_MODES } from "../src/schema.js";

const home = "/home/fixture-user";
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

  it("scales with extra turns", () => {
    const big = generateFixtures({ outDir: mkdtempSync(join(tmpdir(), "as-fx-")), seed: 5, extraTurns: 20, home, username: "fixture-user" });
    const { session } = prepareShare(readFileSync(big.claudeFile, "utf8"), { mode: "brief", config: DEFAULT_CONFIG, harness: "claude-code", machine, knownSecrets: [] });
    expect(session.stats.turns).toBe(28);
  });
});
