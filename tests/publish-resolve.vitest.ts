import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GistPublisher } from "../src/publish/gist.js";
import type { CommandRunner } from "../src/publish/types.js";
import { projectDir as claudeProjectDir } from "../src/harnesses/claude-code/index.js";
import { projectDir as piProjectDir } from "../src/harnesses/pi/index.js";
import { resolveSession, type SessionRoots } from "../src/resolve.js";
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
    const result = await new GistPublisher({ viewerUrl: "https://overshare.link/s/", run }).publish({
      content: "{}",
      description: "overshare: test",
    });
    expect(result).toEqual({
      id: "abc123def4567890abcd",
      url: "https://gist.github.com/abc123def4567890abcd",
      viewerUrl: "https://overshare.link/s/#octocat/abc123def4567890abcd",
      rawUrl: "https://gist.githubusercontent.com/octocat/abc123def4567890abcd/raw/session.json",
    });
    const create = calls.find((c) => c[1] === "gist")!;
    expect(create).not.toContain("--public");
    expect(create.at(-1)).toMatch(/session\.json$/);
  });

  it("deletes a gist non-interactively", async () => {
    const calls: string[][] = [];
    const run: CommandRunner = async (cmd, args) => (calls.push([cmd, ...args]), { code: 0, stdout: "", stderr: "" });
    await new GistPublisher({ viewerUrl: "x", run }).delete("abc123def4567890abcd");
    expect(calls).toEqual([["gh", "gist", "delete", "abc123def4567890abcd", "--yes"]]);
    const failing: CommandRunner = async () => ({ code: 1, stdout: "", stderr: "gist not found" });
    await expect(new GistPublisher({ viewerUrl: "x", run: failing }).delete("abc")).rejects.toThrow(/gist not found/);
  });

  it("fails clearly when gh is not authenticated", async () => {
    const run: CommandRunner = async () => ({ code: 1, stdout: "", stderr: "not logged in" });
    await expect(new GistPublisher({ viewerUrl: "x", run }).publish({ content: "{}", description: "d" })).rejects.toThrow(
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
    expect(claudeProjectDir("/home/u/.herdr/x")).toBe("-home-u--herdr-x");
    expect(piProjectDir("/home/u/.herdr/x")).toBe("--home-u-.herdr-x--");
  });

  it("finds the current Claude Code session from CLAUDE_CODE_SESSION_ID", () => {
    const r = roots();
    const cwd = "/work/demo";
    const dir = join(r["claude-code"], claudeProjectDir(cwd));
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
    const dir = join(r.pi, piProjectDir(cwd));
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
      expect(url).toBe(`http://127.0.0.1:${port}/s/`);
      server.close();
      await expect(startViewerServer({ port: taken, host: "127.0.0.1", strictPort: true })).rejects.toThrow(/already in use/);
    } finally {
      blocker.close();
    }
  });
});

describe("serve bind address", () => {
  it("listens on loopback only unless a host is given", async () => {
    const { startViewerServer } = await import("../src/serve.js");
    const local = await startViewerServer({ port: 0 });
    try {
      expect(local.server.address()).toMatchObject({ address: "127.0.0.1" });
      expect(local.url).toBe(`http://127.0.0.1:${local.port}/s/`);
    } finally {
      local.server.close();
    }
    const all = await startViewerServer({ port: 0, host: "0.0.0.0" });
    try {
      expect(all.server.address()).toMatchObject({ address: "0.0.0.0" });
      expect(all.url).toBe(`http://localhost:${all.port}/s/`);
    } finally {
      all.server.close();
    }
  });
});

describe("local share index", () => {
  it("lists served share files for the viewer's picker", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { startViewerServer } = await import("../src/serve.js");
    const dir = mkdtempSync(join(tmpdir(), "as-idx-"));
    const good = join(dir, "a.json");
    const bad = join(dir, "b.json");
    writeFileSync(good, JSON.stringify({ schema: "overshare/1", title: "T", harness: { name: "pi" }, mode: "brief", stats: { turns: 3 }, project: { name: "app", branch: "main" }, startedAt: "2026-01-01T00:00:00Z" }));
    writeFileSync(bad, "{not json");
    const { server, url } = await startViewerServer({ port: 0, host: "127.0.0.1", files: [good, bad] });
    try {
      const index = await (await fetch(`${url}local/index.json`)).json();
      expect(index[0]).toEqual({ name: "a.json", title: "T", harness: "pi", mode: "brief", turns: 3, project: "app @ main", startedAt: "2026-01-01T00:00:00Z" });
      expect(index[1]).toMatchObject({ name: "b.json" });
      expect(index[1].error).toBeTruthy();
      expect((await fetch(`${url}local/a.json`)).status).toBe(200);
      // Malformed percent-encoding must not crash the server.
      expect((await fetch(`${url}local/%E0%A4%A`)).status).toBe(400);
      expect((await fetch(`${url}local/index.json`)).status).toBe(200);
    } finally {
      server.close();
    }
  });
});

describe("serve with unusual file names", () => {
  it("serves a share whose name contains %", async () => {
    const { copyFileSync, mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { startViewerServer } = await import("../src/serve.js");
    const dir = mkdtempSync(join(tmpdir(), "as-pct-"));
    const src = join(dir, "src.json");
    writeFileSync(src, JSON.stringify({ schema: "overshare/1", title: "pct" }));
    const file = join(dir, "50%off.json");
    copyFileSync(src, file);
    const { server, url } = await startViewerServer({ port: 0, host: "127.0.0.1", files: [file] });
    try {
      const res = await fetch(`${url}local/${encodeURIComponent("50%off.json")}`);
      expect(res.status).toBe(200);
      expect((await res.json()).title).toBe("pct");
    } finally {
      server.close();
    }
  });
});

/** GET with a raw path and Host header (fetch normalizes `..` and won't send a foreign Host). */
async function rawGet(port: number, path: string, host?: string): Promise<number> {
  const { request } = await import("node:http");
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, headers: host ? { Host: host } : {} }, (res) => {
      res.resume();
      resolve(res.statusCode!);
    });
    req.on("error", reject);
    req.end();
  });
}

describe("serve host check (DNS rebinding)", () => {
  it("accepts IPs, localhost and listed names; refuses other host names", async () => {
    const { hostAllowed } = await import("../src/serve.js");
    for (const h of ["127.0.0.1:3000", "localhost:3000", "LOCALHOST.", "app.localhost", "[::1]:3000", "192.168.1.20:3000", undefined]) {
      expect(hostAllowed(h), String(h)).toBe(true);
    }
    for (const h of ["evil.example", "evil.example:3000", "localhost.evil.example", "localhost@evil.example", "", "a b"]) {
      expect(hostAllowed(h), h).toBe(false);
    }
    expect(hostAllowed("box.tail1234.ts.net:3000", ["box.tail1234.ts.net"])).toBe(true);
    expect(hostAllowed("BOX.local", ["box.local"])).toBe(true);
  });

  it("refuses a request whose Host names another domain, even on loopback", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { startViewerServer } = await import("../src/serve.js");
    const file = join(mkdtempSync(join(tmpdir(), "as-host-")), "a.json");
    writeFileSync(file, JSON.stringify({ schema: "overshare/1", title: "T" }));
    const { server, port } = await startViewerServer({ port: 0, host: "127.0.0.1", files: [file], allowedHosts: ["box.lan"] });
    try {
      expect(await rawGet(port, "/s/local/a.json", `evil.example:${port}`)).toBe(403);
      expect(await rawGet(port, "/s/local/index.json", `evil.example:${port}`)).toBe(403);
      expect(await rawGet(port, "/s/local/a.json", `localhost:${port}`)).toBe(200);
      expect(await rawGet(port, "/s/local/a.json", `box.lan:${port}`)).toBe(200);
    } finally {
      server.close();
    }
  });
});

describe("serve path check", () => {
  it("serves nothing outside the viewer directory, including siblings that share its prefix", async () => {
    const { startViewerServer } = await import("../src/serve.js");
    const { server, port } = await startViewerServer({ port: 0, host: "127.0.0.1" });
    try {
      expect(await rawGet(port, "/s/index.html")).toBe(200);
      // dist/standalone.html starts with "dist/s"; it must not pass as inside dist/s/.
      expect(await rawGet(port, "/s/..%2fstandalone.html")).toBe(404);
      expect(await rawGet(port, "/s/..%2f..%2fconfig.mjs")).toBe(404);
    } finally {
      server.close();
    }
  });
});

describe("loadConfig", () => {
  it("records where viewerUrl came from", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { loadConfig } = await import("../src/config.js");
    const file = join(mkdtempSync(join(tmpdir(), "as-cfg-")), "config.json");
    expect(loadConfig({ OVERSHARE_CONFIG: file }).viewerUrlSource).toBe("default");
    writeFileSync(file, JSON.stringify({ viewerUrl: "https://mine.example.com/s/" }));
    expect(loadConfig({ OVERSHARE_CONFIG: file })).toMatchObject({ viewerUrl: "https://mine.example.com/s/", viewerUrlSource: "config" });
    expect(loadConfig({ OVERSHARE_CONFIG: file, OVERSHARE_VIEWER_URL: "https://env.example.com/" }).viewerUrlSource).toBe("env");
  });
});
