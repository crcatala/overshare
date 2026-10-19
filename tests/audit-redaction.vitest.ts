import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { describeSession, formatSummary, readSnapshot, runSide, type Manifest, type SideResults } from "../scripts/audit-redaction.ts";
import { findSecretPatterns } from "../src/redact/patterns.js";
import { ClaudeTranscript, PiTranscript, ccUsage, fake, randomish } from "./helpers.js";

const root = join(import.meta.dirname, "..");

/** A Claude Code and a pi session in fake session roots, holding planted credentials (one inside escaped JSON). */
function fakeSessions() {
  const dir = mkdtempSync(join(tmpdir(), "ovs-audit-test-"));
  const secrets = [fake.github(), fake.anthropic(), `Q${randomish(23, 41)}`];
  const [github, anthropic, password] = secrets as [string, string, string];
  const claudeRoot = join(dir, "claude");
  const piRoot = join(dir, "pi");
  mkdirSync(join(claudeRoot, "-home-tester-work-demo"), { recursive: true });
  mkdirSync(join(piRoot, "--home-tester-work-demo--"), { recursive: true });
  const claude = join(claudeRoot, "-home-tester-work-demo", "11111111-2222-3333-4444-555555555555.jsonl");
  const cc = new ClaudeTranscript()
    .user("check the config")
    .assistant("m1", [{ type: "tool_use", id: "b1", name: "Bash", input: { command: "curl -s localhost/config" } }], ccUsage(1, 1))
    .toolResult("b1", JSON.stringify({ log: JSON.stringify({ user: "svc", ["pass" + "word"]: password }) }))
    .assistant("m2", [{ type: "tool_use", id: "b2", name: "Bash", input: { command: "cat .npmrc" } }], ccUsage(1, 1))
    .toolResult("b2", `token = ${github}`)
    .assistant("m3", [{ type: "text", text: "done" }], ccUsage(1, 1));
  writeFileSync(claude, cc.toJsonl());
  const pi = join(piRoot, "--home-tester-work-demo--", "2026-01-01T00-00-00-000Z_01a0aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee.jsonl");
  const p = new PiTranscript().user("what key is set?");
  p.assistant([{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "env" } }]);
  p.toolResult("c1", "bash", `ANTHROPIC_API_KEY=${anthropic}`);
  writeFileSync(pi, p.toJsonl());
  return { dir, claudeRoot, piRoot, claude, pi, secrets };
}

/** No 6-character piece of a planted value appears in `text`. */
function expectNoFragments(text: string, secrets: string[]): void {
  for (const s of secrets) for (let i = 0; i + 6 <= s.length; i++) expect(text.includes(s.slice(i, i + 6)), `fragment at ${i} of a planted value`).toBe(false);
}

function manifestFor(f: ReturnType<typeof fakeSessions>): Manifest {
  const entry = (harness: "claude-code" | "pi", path: string) => ({ harness, path, size: statSync(path).size, mtimeMs: statSync(path).mtimeMs });
  return { base: "main", sha: "0".repeat(40), modes: ["brief", "full"], sessions: [entry("claude-code", f.claude), entry("pi", f.pi)], live: [] };
}

describe("audit:redaction", { timeout: 60_000 }, () => {
  it("reports what changed by status, rule and count, never a value", async () => {
    const f = fakeSessions();
    const manifest = manifestFor(f);
    const head = await runSide(root, "working tree", manifest);
    expect(head.sessions[f.claude]?.full?.status).toBe("review");
    expect(head.sessions[f.pi]?.full?.status).toBe("review");
    // A base that found none of it.
    const base: SideResults = structuredClone(head);
    base.label = "main (0000000)";
    for (const s of Object.values(base.sessions)) for (const r of Object.values(s)) Object.assign(r, { status: "clean", rules: {}, rescan: [], suspicious: [] });

    const summary = formatSummary(manifest, base, head).join("\n");
    expect(summary).toContain("Sessions: 2 (claude-code 1, pi 1)");
    expect(summary).toContain("clean → review 2");
    expect(summary).toMatch(/\+1 github\S* \(high\) in 1 session/);
    expect(summary).toContain(f.claude);
    expectNoFragments(summary, f.secrets);
    // The saved results hold no more than the summary does.
    expectNoFragments(JSON.stringify(head), f.secrets);
  });

  it("--shape describes each new match without its value", () => {
    const f = fakeSessions();
    const manifest = manifestFor(f);
    const shapes = manifest.sessions.flatMap((s) => describeSession(s, () => [], (t) => findSecretPatterns(t))).join("\n");
    expect(shapes).toMatch(/github\S* \(high\) key=token length 40, lower\+upper\+digit\+symbol/);
    expect(shapes).toMatch(/secret-assignment \(medium\) key=password length 24, lower\+upper\+digit, entropy [\d.]+, escaped quotes/);
    expect(shapes).toMatch(/anthropic \(high\) key=ANTHROPIC_API_KEY length \d+/);
    expectNoFragments(shapes, f.secrets);
    // Nothing new against itself.
    expect(describeSession(manifest.sessions[0]!, (t) => findSecretPatterns(t), (t) => findSecretPatterns(t))).toEqual(["    nothing new from the pattern layer"]);
  });

  it("reads a session as it was when the audit started, up to its last complete line", () => {
    const file = join(mkdtempSync(join(tmpdir(), "ovs-audit-test-")), "s.jsonl");
    writeFileSync(file, '{"a":1}\n{"b":2}\n');
    const size = statSync(file).size;
    appendFileSync(file, '{"c":3}\n{"d":');
    expect(readSnapshot(file, size)).toBe('{"a":1}\n{"b":2}\n');
    expect(readSnapshot(file, size + 3)).toBe('{"a":1}\n{"b":2}\n');
    expect(readSnapshot(file, statSync(file).size)).toBe('{"a":1}\n{"b":2}\n{"c":3}\n{"d":');
  });

  it("runs end to end against a git ref, exits 0 and prints no value", () => {
    const f = fakeSessions();
    const out = join(f.dir, "results");
    const env = { ...process.env, OVERSHARE_CLAUDE_PROJECTS: f.claudeRoot, OVERSHARE_PI_SESSIONS: f.piRoot, HOME: f.dir };
    const worktrees = () => spawnSync("git", ["worktree", "list"], { cwd: root, encoding: "utf8" }).stdout;
    const before = worktrees();
    const run = (args: string[]) => spawnSync(process.execPath, ["--import", "tsx", join(root, "scripts", "audit-redaction.ts"), ...args], { cwd: root, encoding: "utf8", env });

    const r = run(["--base", "HEAD", "--out", out, "--shape", "changed"]);
    expect(r.stderr).not.toContain("failed");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Sessions: 2 (claude-code 1, pi 1)");
    expect(r.stdout).toContain("Sessions that changed: none");
    expectNoFragments(r.stdout + r.stderr, f.secrets);
    for (const name of readdirSync(out)) expectNoFragments(readFileSync(join(out, name), "utf8"), f.secrets);

    // Saved results compared again, and one session described against the base.
    const again = run(["--from", out, "--shape", f.claude]);
    expect(again.status).toBe(0);
    expect(again.stdout).toContain("nothing new from the pattern layer");
    expectNoFragments(again.stdout + again.stderr, f.secrets);
    // The base worktree is gone.
    expect(worktrees()).toBe(before);
  });
});
