import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { pricePreflight, unpricedProblem } from "../scripts/price-preflight.ts";
import { fromModelsDev, renderTable } from "../scripts/prices.ts";
import { ClaudeTranscript, ccUsage } from "./helpers.js";

const MODELS_DEV = join(import.meta.dirname, "fixtures", "prices", "models-dev.json");
const FRESH = renderTable(fromModelsDev(JSON.parse(readFileSync(MODELS_DEV, "utf8"))));
// An unreachable proxy stands in for being offline.
const OFFLINE = { ...process.env, NODE_USE_ENV_PROXY: "1", HTTPS_PROXY: "http://127.0.0.1:9", https_proxy: "http://127.0.0.1:9" };

function tableFile(text: string): string {
  const file = join(mkdtempSync(join(tmpdir(), "preflight-")), "pricing-data.ts");
  writeFileSync(file, text);
  return file;
}

describe("price preflight", { timeout: 60_000 }, () => {
  it("says so when the committed table is current", () => {
    const r = pricePreflight({ generatorArgs: ["--from", MODELS_DEV, "--table", tableFile(FRESH)] });
    expect(r.lines).toEqual(["Price table is current with models.dev (snapshot 2026-10-07)."]);
  });

  it("warns about a stale table, naming what changed and the fix", () => {
    const stale = FRESH.replace("cacheRead: 0.1, cacheWrite: 2.5 }", "cacheRead: 0.2, cacheWrite: 2.5 }").replace(/^ {2}"claude-haiku-5-5".*\n/m, "");
    const r = pricePreflight({ generatorArgs: ["--from", MODELS_DEV, "--table", tableFile(stale)] });
    expect(r.lines[0]).toBe("WARNING: the committed price table is stale (models.dev snapshot 2026-10-07): claude-haiku-5-5 added; claude-sonnet-5-5 cacheRead 0.2 -> 0.1.");
    expect(r.lines[1]).toContain("Fix: npm run update:prices (or rerun with --refresh)");
  });

  it("warns and lets the audit run when models.dev cannot be reached", () => {
    const r = pricePreflight({ env: OFFLINE, generatorArgs: ["--table", tableFile(FRESH)] });
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]).toMatch(/^WARNING: could not check the price table against models.dev \(update-prices failed: could not fetch https:\/\/models.dev\/api.json .*\); auditing with the committed one\.$/);
    const refresh = pricePreflight({ refresh: true, env: OFFLINE, generatorArgs: ["--table", tableFile(FRESH)] });
    expect(refresh.refreshed).toBeUndefined();
    expect(refresh.lines[0]).toMatch(/^WARNING: could not refresh the price table/);
  });

  it("regenerates the table with --refresh", () => {
    const table = tableFile(FRESH.replace("cacheRead: 0.1, cacheWrite: 2.5 }", "cacheRead: 0.2, cacheWrite: 2.5 }"));
    const r = pricePreflight({ refresh: true, generatorArgs: ["--from", MODELS_DEV, "--table", table] });
    expect(r).toMatchObject({ refreshed: true, lines: ["Price table regenerated from models.dev (updated src/pricing-data.ts)."] });
    expect(readFileSync(table, "utf8")).toBe(FRESH);
    expect(pricePreflight({ refresh: true, generatorArgs: ["--from", MODELS_DEV, "--table", table] }).lines[0]).toContain("(no change)");
  });
});

describe("unpriced models", () => {
  it("fails naming each model and its call count, or warns with --allow-unpriced", () => {
    expect(unpricedProblem(new Map(), false)).toBeUndefined();
    const seen = new Map([["claude-new-1", 1], ["claude-new-2", 12]]);
    const fail = unpricedProblem(seen, false)!;
    expect(fail.fail).toBe(true);
    expect(fail.lines).toEqual([
      "FAIL: models with no price in local sessions:",
      "  claude-new-2 (12 calls)",
      "  claude-new-1 (1 call)",
      "  Fix: npm run update:prices, or add the model to SUPPLEMENTAL_PRICES in src/pricing.ts if models.dev does not list it.",
      "  Rerun with --allow-unpriced to audit anyway.",
    ]);
    const allowed = unpricedProblem(seen, true)!;
    expect(allowed.fail).toBe(false);
    expect(allowed.lines[0]).toBe("WARNING: models with no price (allowed by --allow-unpriced):");
    expect(allowed.lines).not.toContain("  Rerun with --allow-unpriced to audit anyway.");
  });
});

describe("audit:usage end to end (synthetic sessions, offline)", { timeout: 120_000 }, () => {
  function sessions(model: string) {
    const dir = mkdtempSync(join(tmpdir(), "audit-"));
    const project = join(dir, "claude", "-home-tester-work-demo");
    mkdirSync(project, { recursive: true });
    mkdirSync(join(dir, "pi"));
    const t = new ClaudeTranscript();
    t.user("hi").assistant("msg_1", [{ type: "text", text: "hello" }], ccUsage(10, 20), model).user("again").assistant("msg_2", [{ type: "text", text: "ok" }], ccUsage(12, 30), model);
    writeFileSync(join(project, `${t.sessionId}.jsonl`), t.toJsonl());
    return { ...OFFLINE, OVERSHARE_CLAUDE_PROJECTS: join(dir, "claude"), OVERSHARE_PI_SESSIONS: join(dir, "pi") };
  }
  const audit = (env: NodeJS.ProcessEnv, ...args: string[]) =>
    spawnSync(process.execPath, ["--import", "tsx", join(import.meta.dirname, "..", "scripts", "audit-usage.ts"), ...args], { encoding: "utf8", env });

  it("fails on a model the table does not price, and audits with --allow-unpriced", () => {
    const env = sessions("claude-unreleased-9");
    const r = audit(env);
    expect(r.status, r.stderr).toBe(1);
    expect(r.stdout).toContain("WARNING: could not check the price table against models.dev");
    expect(r.stdout).toContain("FAIL: models with no price in local sessions:\n  claude-unreleased-9 (2 calls)");
    expect(r.stdout).not.toContain("pi:");
    const allowed = audit(env, "--allow-unpriced");
    expect(allowed.status, allowed.stderr).toBe(0);
    expect(allowed.stdout).toContain("WARNING: models with no price (allowed by --allow-unpriced):\n  claude-unreleased-9 (2 calls)");
    expect(allowed.stdout).toContain("pi: 0 sessions");
  });

  it("passes when every model is priced, even offline", () => {
    const r = audit(sessions("claude-opus-5-5"));
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("Claude Code: 1 sessions");
    expect(r.stdout).not.toContain("FAIL");
  });
});
