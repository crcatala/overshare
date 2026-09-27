import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ClaudeTranscript, ccUsage, fake } from "./helpers.js";

const root = join(import.meta.dirname, "..");

function cli(args: string[], env: Record<string, string> = {}) {
  const home = mkdtempSync(join(tmpdir(), "as-cli-home-"));
  return spawnSync(process.execPath, ["--import", "tsx", join(root, "src", "cli.ts"), ...args], {
    encoding: "utf8",
    cwd: root,
    // Isolate from the real machine: no real credentials, config or gh.
    env: { PATH: process.env.PATH ?? "", HOME: home, XDG_CONFIG_HOME: join(home, ".config"), NO_COLOR: "1", PI_CODING_AGENT_DIR: join(home, "pi"), CLAUDE_CONFIG_DIR: join(home, "claude"), ...env },
    input: "",
  });
}

function sessionFile(secretInOutput?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "as-cli-"));
  const file = join(dir, "s.jsonl");
  const t = new ClaudeTranscript()
    .user("run it")
    .assistant("m1", [{ type: "tool_use", id: "b1", name: "Bash", input: { command: "cat config" } }], ccUsage(1, 1))
    .toolResult("b1", secretInOutput ? `token: ${secretInOutput}` : "ok")
    .assistant("m2", [{ type: "text", text: "done" }], ccUsage(1, 1));
  writeFileSync(file, t.toJsonl());
  return file;
}

describe("cli", { timeout: 30_000 }, () => {
  it("report exits 0 for a clean session and 2 when secrets were redacted", () => {
    const clean = cli(["report", sessionFile(), "--mode", "full"]);
    expect(clean.status).toBe(0);
    expect(clean.stdout).toContain("Status: CLEAN");

    const secret = fake.github();
    const dirty = cli(["report", sessionFile(secret), "--mode", "full", "--json"]);
    expect(dirty.status).toBe(2);
    const report = JSON.parse(dirty.stdout);
    expect(report.clean).toBe(false);
    expect(dirty.stdout).not.toContain(secret);
  });

  it("export writes redacted JSON", () => {
    const secret = fake.github();
    const out = join(mkdtempSync(join(tmpdir(), "as-out-")), "share.json");
    const r = cli(["export", sessionFile(secret), "--mode", "full", "-o", out, "-q"]);
    expect(r.status).toBe(0);
    const json = readFileSync(out, "utf8");
    expect(JSON.parse(json).schema).toBe("agentshare/1");
    expect(json).not.toContain(secret);
  });

  it("publish refuses --yes when the report is not clean (and never reaches gh)", () => {
    const r = cli(["publish", sessionFile(fake.github()), "--mode", "full", "--yes"], { PATH: "/nonexistent" });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("--yes only applies to clean reports");
  });
});
