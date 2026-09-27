import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GistPublisher } from "../src/publish/gist.js";
import type { CommandRunner } from "../src/publish/types.js";
import { projectDirName, resolveSession, type SessionRoots } from "../src/resolve.js";
import { ClaudeTranscript, PiTranscript } from "./helpers.js";

describe("GistPublisher", () => {
  it("creates a secret gist and returns an owner/id viewer link", async () => {
    const calls: string[][] = [];
    const run: CommandRunner = async (cmd, args) => {
      calls.push([cmd, ...args]);
      if (args[0] === "gist") return { code: 0, stdout: "- Creating gist session.json\nhttps://gist.github.com/abc123def4567890abcd\n", stderr: "" };
      if (args[0] === "api") return { code: 0, stdout: "octocat\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    };
    const result = await new GistPublisher({ viewerUrl: "https://agent.nub.sh/session/", run }).publish({
      filename: "session.json",
      content: "{}",
      description: "agent-share: test",
    });
    expect(result).toEqual({
      publisher: "gist",
      id: "abc123def4567890abcd",
      url: "https://gist.github.com/abc123def4567890abcd",
      viewerUrl: "https://agent.nub.sh/session/#octocat/abc123def4567890abcd",
      rawUrl: "https://gist.githubusercontent.com/octocat/abc123def4567890abcd/raw/session.json",
    });
    const create = calls.find((c) => c[1] === "gist")!;
    expect(create).not.toContain("--public");
    expect(create.at(-1)).toMatch(/session\.json$/);
  });

  it("fails clearly when gh is not authenticated", async () => {
    const run: CommandRunner = async () => ({ code: 1, stdout: "", stderr: "not logged in" });
    await expect(new GistPublisher({ viewerUrl: "x", run }).publish({ filename: "session.json", content: "{}", description: "d" })).rejects.toThrow(
      /not logged in/,
    );
  });
});

describe("resolveSession", () => {
  function roots(): SessionRoots {
    const base = mkdtempSync(join(tmpdir(), "as-roots-"));
    return { "claude-code": join(base, "claude"), pi: join(base, "pi") };
  }

  it("maps a cwd to each harness's directory naming", () => {
    expect(projectDirName("claude-code", "/home/u/.herdr/x")).toBe("-home-u--herdr-x");
    expect(projectDirName("pi", "/home/u/.herdr/x")).toBe("--home-u-.herdr-x--");
  });

  it("finds the current Claude Code session from CLAUDE_CODE_SESSION_ID", () => {
    const r = roots();
    const cwd = "/work/demo";
    const dir = join(r["claude-code"], projectDirName("claude-code", cwd));
    mkdirSync(dir, { recursive: true });
    const id = "aaaaaaaa-1111-2222-3333-444444444444";
    writeFileSync(join(dir, `${id}.jsonl`), new ClaudeTranscript(id).user("x").toJsonl());
    writeFileSync(join(dir, "bbbbbbbb-1111-2222-3333-444444444444.jsonl"), new ClaudeTranscript().user("newer").toJsonl());
    const ref = resolveSession(undefined, { current: true, cwd, roots: r, env: { CLAUDE_CODE_SESSION_ID: id } });
    expect(ref).toMatchObject({ harness: "claude-code", id });
  });

  it("falls back to the newest session for the cwd, and resolves id prefixes", () => {
    const r = roots();
    const cwd = "/work/demo";
    const dir = join(r.pi, projectDirName("pi", cwd));
    mkdirSync(dir, { recursive: true });
    const older = join(dir, "2026-01-01T00-00-00-000Z_01a0old0-0000-7000-8000-000000000000.jsonl");
    const newer = join(dir, "2026-01-02T00-00-00-000Z_01a0new0-0000-7000-8000-000000000000.jsonl");
    writeFileSync(older, new PiTranscript("01a0old0-0000-7000-8000-000000000000").user("a").toJsonl());
    writeFileSync(newer, new PiTranscript("01a0new0-0000-7000-8000-000000000000").user("b").toJsonl());
    utimesSync(older, new Date(2026, 0, 1), new Date(2026, 0, 1));
    expect(resolveSession(undefined, { current: true, cwd, roots: r, env: {} }).path).toBe(newer);
    expect(resolveSession("01a0old", { roots: r, env: {} })).toMatchObject({ harness: "pi", path: older });
    expect(resolveSession(older, { roots: r, env: {} }).harness).toBe("pi");
    expect(() => resolveSession("01a0", { roots: r, env: {} })).toThrow(/ambiguous/);
    expect(() => resolveSession("zzz", { roots: r, env: {} })).toThrow(/No session/);
  });
});

describe("startViewerServer", () => {
  it("falls back to the next free port unless strictPort is set", async () => {
    const { createServer } = await import("node:net");
    const { startViewerServer } = await import("../src/serve.js");
    const blocker = createServer();
    await new Promise<void>((r) => blocker.listen(0, "127.0.0.1", r));
    const taken = (blocker.address() as { port: number }).port;
    try {
      const { server, port, url } = await startViewerServer({ port: taken, host: "127.0.0.1" });
      expect(port).toBeGreaterThan(taken);
      expect(url).toBe(`http://127.0.0.1:${port}/session/`);
      server.close();
      await expect(startViewerServer({ port: taken, host: "127.0.0.1", strictPort: true })).rejects.toThrow(/already in use/);
    } finally {
      blocker.close();
    }
  });
});
