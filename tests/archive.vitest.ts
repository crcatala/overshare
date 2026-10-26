/**
 * `overshare archive`, end to end through the CLI: where files go, what their frontmatter says, when a re-run skips
 * or rewrites, and how findings are reported. Each test gets its own fake home, so nothing touches the real machine.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import { ClaudeTranscript, ccUsage, fake, randomish } from "./helpers.js";

const root = join(import.meta.dirname, "..");

interface Machine {
  home: string;
  projects: string;
  archive: string;
  run: (args: string[], env?: Record<string, string>) => ReturnType<typeof spawnSync> & { stdout: string; stderr: string };
}

function machine(): Machine {
  const home = mkdtempSync(join(tmpdir(), "as-archive-home-"));
  const projects = join(home, "claude", "projects");
  const run = (args: string[], env: Record<string, string> = {}) =>
    spawnSync(process.execPath, ["--import", "tsx", join(root, "src", "cli.ts"), "archive", ...args], {
      encoding: "utf8",
      cwd: root,
      env: { PATH: process.env.PATH ?? "", HOME: home, USER: "tester", XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, "data"), NO_COLOR: "1", PI_CODING_AGENT_DIR: join(home, "pi"), CLAUDE_CONFIG_DIR: join(home, "claude"), ...env },
      input: "",
    });
  return { home, projects, archive: join(home, "data", "overshare", "archive"), run };
}

/**
 * A Claude Code session under the fake home's projects folder, its last entry a minute before `mtime` (default now),
 * since `--since` goes by the last entry's time. Returns its path.
 */
function addSession(m: Machine, id: string, build: (t: ClaudeTranscript) => ClaudeTranscript, mtime = new Date(), cwd = join(m.home, "work", "demo")): string {
  const dir = join(m.projects, cwd.replace(/[^A-Za-z0-9]/g, "-"));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${id}.jsonl`);
  const t = build(new ClaudeTranscript(id, cwd));
  t.lines.forEach((l, i) => {
    if (l.timestamp) l.timestamp = new Date(mtime.getTime() - 60_000 - (t.lines.length - i) * 1000).toISOString();
  });
  writeFileSync(file, t.toJsonl());
  utimesSync(file, mtime, mtime);
  return file;
}

/** The archive name of a session file: `<project>/<start date>_claude-code_<project>_<id8>.md`. */
function nameFor(file: string, project = "demo"): string {
  const first = JSON.parse(readFileSync(file, "utf8").split("\n", 1)[0]!) as { timestamp: string; sessionId: string };
  return join(project, `${first.timestamp.slice(0, 10)}_claude-code_${project}_${first.sessionId.slice(0, 8)}.md`);
}

const simple = (t: ClaudeTranscript) =>
  t
    .user("fix the bug")
    .assistant("m1", [{ type: "tool_use", id: "b1", name: "Bash", input: { command: "npm test" } }], ccUsage(10, 5))
    .toolResult("b1", "ok")
    .assistant("m2", [{ type: "text", text: "Fixed it." }], ccUsage(10, 5));

const ID = "aaaaaaaa-1111-4222-8333-444444444444";
/** The session files in an archive folder, relative to it (`<project>/<file>.md`), without the report. */
const filesIn = (dir: string) => (existsSync(dir) ? (readdirSync(dir, { recursive: true }) as string[]).filter((f) => f.endsWith(".md") && !basename(f).startsWith("_")).sort() : []);
const archived = (m: Machine) => filesIn(m.archive);

describe("overshare archive", { timeout: 60_000 }, () => {
  it("writes one session to the default folder as minimal markdown with redacted frontmatter, private", () => {
    const m = machine();
    const file = addSession(m, ID, simple);
    const r = m.run([ID]);
    expect(r.status, r.stderr).toBe(0);
    expect(archived(m)).toEqual([nameFor(file)]);
    const out = join(m.archive, archived(m)[0]!);
    expect(statSync(out).mode & 0o777).toBe(0o600);
    expect(statSync(m.archive).mode & 0o777).toBe(0o700);
    const md = readFileSync(out, "utf8");
    expect(md).toContain('mode: "minimal"');
    expect(md).toContain('cwd: "~/work/demo"');
    expect(md).toContain('branch: "main"');
    // The home folder's path slug in the project folder name is redacted like a home path.
    expect(md).toContain(`source_path: "~/claude/projects/-home-[user]-work-demo/${ID}.jsonl"`);
    expect(md).not.toContain(m.home);
    expect(md).toMatch(/usage:\n {2}input_tokens: 20\n {2}output_tokens: 10/);
    expect(md).toContain("redactions:\n  secrets: 0\n  suspicious: 0");
    expect(md).toContain("## User (Turn 1)\n\nfix the bug\n\n## Assistant (Turn 1)\n\nFixed it.\n");
    expect(md).not.toContain("npm test");
    // A single session does not replace a sweep's report.
    expect(existsSync(join(m.archive, "_archive-report.md"))).toBe(false);
  });

  it("skips an unchanged session, rewrites one that grew or a different mode or --tools, and --overwrite forces it", () => {
    const m = machine();
    const file = addSession(m, ID, simple);
    expect(m.run([ID]).status).toBe(0);
    const again = m.run([ID]);
    expect(again.stderr).toContain("1 up to date.");

    appendFileSync(file, `${JSON.stringify({ type: "user", uuid: "u-extra", parentUuid: "u-4", sessionId: ID, cwd: join(m.home, "work", "demo"), timestamp: "2026-01-01T00:01:00.000Z", message: { role: "user", content: "and the docs" } })}\n`);
    const grown = m.run([ID]);
    expect(grown.stderr).toContain("updated");
    expect(readFileSync(join(m.archive, archived(m)[0]!), "utf8")).toContain("## User (Turn 2)\n\nand the docs");
    expect(archived(m)).toHaveLength(1);

    expect(m.run([ID, "-m", "brief"]).stderr).toContain("1 updated.");
    expect(m.run([ID, "-m", "brief"]).stderr).toContain("1 up to date.");
    const tools = m.run([ID, "-m", "brief", "--tools"]);
    expect(tools.stderr).toContain("1 updated.");
    expect(readFileSync(join(m.archive, archived(m)[0]!), "utf8")).toContain("_Tools: Bash ×1_\n- `npm test`");
    expect(m.run([ID, "-m", "brief", "--tools", "--overwrite"]).stderr).toContain("1 updated.");
  });

  it("without frontmatter, compares the file's own mtime with the session's", () => {
    const m = machine();
    const file = addSession(m, ID, simple, new Date("2026-01-02T00:00:00Z"));
    const out = join(m.home, "one.md");
    expect(m.run([ID, "-o", out, "--no-frontmatter"]).status).toBe(0);
    expect(readFileSync(out, "utf8").startsWith("# fix the bug\n")).toBe(true);
    expect(m.run([ID, "-o", out, "--no-frontmatter"]).stderr).toContain("1 up to date.");
    utimesSync(file, new Date(), new Date(Date.now() + 60_000));
    expect(m.run([ID, "-o", out, "--no-frontmatter"]).stderr).toContain("1 updated.");
  });

  it("--all takes sessions active within --since (default 30 days), into the folder given, with a report", () => {
    const m = machine();
    const day = 86_400_000;
    const ago = (n: number) => new Date(Date.now() - n * day);
    const recent = addSession(m, "bbbbbbbb-1111-4222-8333-444444444444", simple, ago(2));
    const older = addSession(m, "cccccccc-1111-4222-8333-444444444444", simple, ago(10));
    addSession(m, "dddddddd-1111-4222-8333-444444444444", simple, ago(60));
    const out = join(m.home, "sweep");

    const week = m.run(["--all", "--since", "7d", "-o", out]);
    expect(week.status, week.stderr).toBe(0);
    expect(filesIn(out)).toEqual([nameFor(recent)]);

    const month = m.run(["--all", "-o", out]);
    expect(month.stderr).toContain("1 written, 1 up to date.");
    const report = readFileSync(join(out, "_archive-report.md"), "utf8");
    expect(report).toContain(`| written | \`${nameFor(older)}\` | clean |`);

    const dated = m.run(["--all", "--since", new Date(Date.now() - 90 * day).toISOString().slice(0, 10), "-o", out, "--json"]);
    expect(JSON.parse(dated.stdout).totals).toEqual({ written: 1, updated: 0, upToDate: 2, heldBack: 0, failed: 0 });
  });

  it("--dry-run writes nothing, not even the folder", () => {
    const m = machine();
    addSession(m, ID, simple);
    const r = m.run(["--all", "--dry-run"]);
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("would write");
    expect(r.stderr).toContain("Dry run, nothing written: 1 would write.");
    expect(existsSync(m.archive)).toBe(false);
  });

  it("writes redacted secrets and suspicious values, lists them for review and exits 2", () => {
    const m = machine();
    const secret = fake.github();
    const planted = `db_password=${randomish(16, 41)}`;
    const file = addSession(m, ID, (t) =>
      t
        .user(`use ${secret} please`)
        .assistant("m1", [{ type: "tool_use", id: "b1", name: "Bash", input: { [planted]: 1 } }], ccUsage(1, 1))
        .toolResult("b1", "ok")
        .assistant("m2", [{ type: "text", text: "done" }], ccUsage(1, 1)),
    );
    const r = m.run(["--all", "-m", "full"]);
    expect(r.status, r.stderr).toBe(2);
    expect(r.stderr).toContain(`written      ${nameFor(file)}  2 secrets redacted (github-pat) · 1 suspicious value left in`);
    expect(r.stderr).toContain("Review: 1 file still contains suspicious values");
    expect(r.stderr).toContain("@ turn 1 · Bash");
    expect(r.stderr).not.toContain(secret);
    const md = readFileSync(join(m.archive, archived(m)[0]!), "utf8");
    expect(md).not.toContain(secret);
    expect(md).toContain("[REDACTED:github-pat]");
    // Two: the prompt, and the title taken from it.
    expect(md).toContain("redactions:\n  secrets: 2\n  suspicious: 1");
    const report = readFileSync(join(m.archive, "_archive-report.md"), "utf8");
    expect(report).toContain("## Suspicious values to review");
    // It sits with the redacted files, so the session path in it is redacted too.
    expect(report).toContain(`From \`~/claude/projects/-home-[user]-work-demo/${ID}.jsonl\``);
    expect(report).not.toContain(m.home);
  });

  it("holds back a session the final re-scan blocks (exit 3) unless --force", () => {
    const m = machine();
    // A session id skips content redaction, so a known secret there is caught only by the re-scan.
    const secret = fake.envValue();
    const secrets = join(m.home, "secrets.env");
    writeFileSync(secrets, `LEAKED=${secret}\n`);
    addSession(m, ID, (t) => new ClaudeTranscript(secret, t.cwd).user("hi").assistant("m1", [{ type: "text", text: "hello" }], ccUsage(1, 1)));
    const held = m.run(["--all", "--secrets-file", secrets]);
    expect(held.status).toBe(3);
    expect(held.stderr).toContain("held back");
    expect(held.stderr).toContain("--force writes it anyway");
    expect(archived(m)).toEqual([]);
    const forced = m.run(["--all", "--secrets-file", secrets, "--force"]);
    expect(forced.status).toBe(0);
    expect(archived(m)).toHaveLength(1);
  });

  it("leaves out the machine name when hostname redaction is on, and takes the folder from config", () => {
    const m = machine();
    addSession(m, ID, simple);
    const dir = join(m.home, "notes", "sessions");
    mkdirSync(join(m.home, ".config", "overshare"), { recursive: true });
    writeFileSync(join(m.home, ".config", "overshare", "config.json"), JSON.stringify({ archive: { dir: "~/notes/sessions" }, redact: { hostname: true } }));
    expect(m.run([ID]).status).toBe(0);
    const [name] = filesIn(dir);
    const md = readFileSync(join(dir, name!), "utf8");
    expect(md).not.toMatch(/^machine:/m);
    expect(md).toMatch(/^source_size: \d+$/m);
  });

  it("redacts the denylist in frontmatter and report paths, and rewrites a file when redaction settings change", () => {
    const m = machine();
    const file = addSession(m, ID, simple);
    expect(m.run([ID]).stderr).toContain("1 written.");
    expect(m.run([ID]).stderr).toContain("1 up to date.");

    // The project folder ("demo") is in the session file's path, which the session's own redaction never sees.
    const config = join(m.home, ".config", "overshare", "config.json");
    mkdirSync(join(m.home, ".config", "overshare"), { recursive: true });
    writeFileSync(config, JSON.stringify({ redact: { denylist: ["demo"] } }));
    expect(m.run([ID]).stderr).toContain("1 updated.");
    const md = readFileSync(join(m.archive, archived(m)[0]!), "utf8");
    expect(md).toMatch(/^source_path: ".*\[REDACTED\].*"$/m);
    expect(md).toMatch(/^settings: "[0-9a-f]{12}"$/m);
    expect(md.split("\n---\n", 1)[0]).not.toContain("demo");
    expect(m.run([ID]).stderr).toContain("1 up to date.");

    const secrets = join(m.home, "secrets.env");
    writeFileSync(secrets, "TOKEN=not-in-this-session-0123456789\n");
    expect(m.run([ID, "--secrets-file", secrets]).stderr).toContain("1 updated.");
    expect(m.run([ID, "--secrets-file", secrets]).stderr).toContain("1 up to date.");
    writeFileSync(secrets, "TOKEN=another-value-0123456789abcdef\n");
    expect(m.run([ID, "--secrets-file", secrets]).stderr).toContain("1 updated.");

    // The report's paths too: a suspicious value puts the session's path in it.
    const risky = addSession(m, "bbbbbbbb-1111-4222-8333-444444444444", (t) =>
      t.user("go").assistant("m1", [{ type: "tool_use", id: "b1", name: "Bash", input: { [`db_password=${randomish(16, 41)}`]: 1 } }], ccUsage(1, 1)).toolResult("b1", "ok"),
    );
    const sweep = m.run(["--all", "-m", "full"]);
    expect(sweep.status, sweep.stderr).toBe(2);
    expect(sweep.stderr).toContain(`from ${risky}`);
    const report = readFileSync(join(m.archive, "_archive-report.md"), "utf8");
    expect(report).toContain("## Suspicious values to review");
    expect(report).toContain("-home-[user]-work-[REDACTED]/bbbbbbbb");
    // The first file was named before the denylist: rewritten with it, it moved to the redacted name.
    expect(report).not.toContain("demo");
    expect(archived(m)).toEqual([nameFor(risky, "redacted"), nameFor(file, "redacted")].sort());
    expect(file).toContain("demo");
  });

  it("--mode full --include-system-prompt writes the system prompt, fenced, before the first turn", () => {
    const m = machine();
    addSession(m, ID, (t) =>
      t
        .attachment({ type: "prompt_snapshot", systemPrompt: ["You are an interactive agent.\n# Not a heading", "```js\nfence();\n```"] })
        .user("hello")
        .assistant("m1", [{ type: "text", text: "hi" }], ccUsage(1, 1)),
    );
    expect(m.run([ID, "-m", "full"]).status).toBe(0);
    const out = join(m.archive, archived(m)[0]!);
    expect(readFileSync(out, "utf8")).not.toContain("System prompt");
    // Opting in changes the content, so the file is rewritten rather than counted as up to date.
    expect(m.run([ID, "-m", "full", "--include-system-prompt"]).stderr).toContain("1 updated.");
    const md = readFileSync(out, "utf8");
    expect(md).toContain("## System prompt\n\n```text\nYou are an interactive agent.\n# Not a heading\n```\n\n````text\n```js\nfence();\n```\n````\n\n## User (Turn 1)");
  });

  it("names and files a worktree session after its repository, and records the worktree", () => {
    const m = machine();
    // Gone from disk, as most worktrees are by the time they are archived: the path's layout names the repository.
    const file = addSession(m, ID, simple, new Date(), join(m.home, ".local", "share", "t3", "worktrees", "acme-api", "t3-6c1e90ab", "packages", "core"));
    const r = m.run([ID]);
    expect(r.status, r.stderr).toBe(0);
    expect(archived(m)).toEqual([nameFor(file, "acme-api")]);
    const md = readFileSync(join(m.archive, archived(m)[0]!), "utf8");
    expect(md).toContain('project: "acme-api"');
    expect(md).toContain('worktree: "t3-6c1e90ab"');
  });

  it("moves a file whose name changed (a loose file from before project folders) instead of writing a second one", () => {
    const m = machine();
    const file = addSession(m, ID, simple);
    expect(m.run([ID]).status).toBe(0);
    const loose = join(m.archive, basename(nameFor(file)));
    renameSync(join(m.archive, nameFor(file)), loose);
    // Written by an older layout: its settings stamp differs, so it is not up to date.
    writeFileSync(loose, readFileSync(loose, "utf8").replace(/^settings: .*$/m, 'settings: "000000000000"'));
    const r = m.run([ID]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toContain(`updated      ${nameFor(file)}  moved from ${basename(nameFor(file))}`);
    expect(archived(m)).toEqual([nameFor(file)]);
    expect(existsSync(loose)).toBe(false);
    expect(m.run([ID]).stderr).toContain("1 up to date.");
  });

  it("names a session in a live worktree after its main checkout, followed through git's files", () => {
    const m = machine();
    const main = join(m.home, "work", "acme-api");
    const gitdir = join(main, ".git", "worktrees", "feature-x");
    mkdirSync(gitdir, { recursive: true });
    writeFileSync(join(gitdir, "commondir"), "../..\n");
    // Somewhere no path layout would recognise: only the .git file says where it belongs.
    const wt = join(m.home, "scratch", "feature-x");
    mkdirSync(wt, { recursive: true });
    writeFileSync(join(wt, ".git"), `gitdir: ${gitdir}\n`);
    const file = addSession(m, ID, simple, new Date(), wt);
    expect(m.run([ID]).status).toBe(0);
    expect(archived(m)).toEqual([nameFor(file, "acme-api")]);
    expect(readFileSync(join(m.archive, archived(m)[0]!), "utf8")).toContain('worktree: "feature-x"');
  });

  it("moves a loose file written without frontmatter, though its mtime says it is up to date", () => {
    const m = machine();
    const file = addSession(m, ID, simple, new Date(Date.now() - 3_600_000));
    expect(m.run([ID, "--no-frontmatter"]).status).toBe(0);
    const loose = join(m.archive, basename(nameFor(file)));
    renameSync(join(m.archive, nameFor(file)), loose);
    const r = m.run([ID, "--no-frontmatter"]);
    expect(r.stderr).toContain(`moved from ${basename(nameFor(file))}`);
    expect(archived(m)).toEqual([nameFor(file)]);
    expect(m.run([ID, "--no-frontmatter"]).stderr).toContain("1 up to date.");
  });

  it("removes the project folder a file moved out of once it is empty, and says a dry run would move it", () => {
    const m = machine();
    const file = addSession(m, ID, simple);
    expect(m.run([ID]).status).toBe(0);
    const old = join(m.archive, "old-name", basename(nameFor(file)));
    mkdirSync(join(m.archive, "old-name"));
    renameSync(join(m.archive, nameFor(file)), old);
    writeFileSync(old, readFileSync(old, "utf8").replace(/^settings: .*$/m, 'settings: "000000000000"'));
    expect(m.run([ID, "--dry-run"]).stderr).toContain(`would update ${nameFor(file)}  would move from ${join("old-name", basename(nameFor(file)))}`);
    expect(existsSync(old)).toBe(true);
    expect(m.run([ID]).status).toBe(0);
    expect(existsSync(join(m.archive, "old-name"))).toBe(false);
    expect(archived(m)).toEqual([nameFor(file)]);
  });

  it("fails, naming the file, when the old file cannot be removed after a move", () => {
    const m = machine();
    const file = addSession(m, ID, simple);
    expect(m.run([ID]).status).toBe(0);
    const folder = join(m.archive, "old-name");
    mkdirSync(folder);
    const old = join(folder, basename(nameFor(file)));
    renameSync(join(m.archive, nameFor(file)), old);
    writeFileSync(old, readFileSync(old, "utf8").replace(/^settings: .*$/m, 'settings: "000000000000"'));
    chmodSync(folder, 0o500);
    try {
      const r = m.run([ID]);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(`could not remove ${join("old-name", basename(nameFor(file)))}`);
      expect(existsSync(join(m.archive, nameFor(file)))).toBe(true);
    } finally {
      chmodSync(folder, 0o700);
    }
  });

  it("does not report a move for a session held back, and leaves its old file", () => {
    const m = machine();
    const secret = fake.envValue();
    const secrets = join(m.home, "secrets.env");
    writeFileSync(secrets, `LEAKED=${secret}\n`);
    addSession(m, ID, (t) => new ClaudeTranscript(secret, t.cwd).user("hi").assistant("m1", [{ type: "text", text: "hello" }], ccUsage(1, 1)));
    expect(m.run(["--all", "--secrets-file", secrets, "--force"]).status).toBe(0);
    const [written] = archived(m);
    const loose = join(m.archive, basename(written!));
    renameSync(join(m.archive, written!), loose);
    const held = m.run(["--all", "--secrets-file", secrets]);
    expect(held.status).toBe(3);
    expect(held.stderr).not.toContain("moved from");
    expect(existsSync(loose)).toBe(true);
  });

  it("rejects option combinations that make no sense", () => {
    const m = machine();
    for (const [args, message] of [
      [["--all", "-o", "x.md"], "with --all, give a folder"],
      [["--since", "7d", ID], "--since only applies with --all"],
      [["--all", ID], "drop the session argument"],
      [["--all", "--since", "soon"], "expected 7d, 12h, 2w or a date"],
      [[], "use --all"],
    ] as const) {
      const r = m.run([...args]);
      expect(r.status, message).toBe(1);
      expect(r.stderr).toContain(message);
    }
  });
});
