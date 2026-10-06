import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
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

  it("report fails with a clear error on an unknown or empty --leaf", () => {
    for (const [leaf, shown] of [["no-such-entry", "no-such-entry"], ["", '""']]) {
      const r = cli(["report", sessionFile(), "--mode", "full", "--leaf", leaf]);
      expect(r.status, shown).not.toBe(0);
      expect(r.status, shown).not.toBe(2);
      expect(r.stderr).toContain(`--leaf ${shown}: no entry with that id in this session`);
      expect(r.stdout).not.toContain("run it");
    }
  });

  it("export writes redacted JSON", () => {
    const secret = fake.github();
    const out = join(mkdtempSync(join(tmpdir(), "as-out-")), "share.json");
    const r = cli(["export", sessionFile(secret), "--mode", "full", "-o", out, "-q"]);
    expect(r.status).toBe(0);
    const json = readFileSync(out, "utf8");
    expect(JSON.parse(json).schema).toBe("overshare/1");
    expect(json).not.toContain(secret);
  });

  it("export --format html writes one self-contained page with the redacted session in it", () => {
    const secret = fake.github();
    const dir = mkdtempSync(join(tmpdir(), "as-html-"));
    const out = join(dir, "share.html");
    const r = cli(["export", sessionFile(secret), "--mode", "full", "-o", out, "-q"]);
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("viewer +");
    // Shown even with -q, and only for HTML.
    expect(r.stderr).toContain("cannot be revoked");
    const page = readFileSync(out, "utf8");
    expect(page.startsWith("<!doctype html>")).toBe(true);
    expect(page).toContain(`id="overshare-session"`);
    expect(page).toContain("overshare/1");
    expect(page).not.toContain(secret);
    // The tab icon is the one link left, and it is a data: URI.
    expect(page).not.toMatch(/<script[^>]*\ssrc=|<link\b(?![^>]*\bhref="data:)/);
    expect(statSync(out).mode & 0o777).toBe(0o600);

    // The extension picks the format; --format wins.
    const asJson = join(dir, "forced.html");
    expect(cli(["export", sessionFile(), "--mode", "full", "--format", "json", "-o", asJson, "-q"]).status).toBe(0);
    expect(JSON.parse(readFileSync(asJson, "utf8")).schema).toBe("overshare/1");
    expect(cli(["export", sessionFile(), "--mode", "full", "-o", join(dir, "plain.json"), "-q"]).stderr).not.toContain("cannot be revoked");
    const noExt = join(dir, "forced");
    expect(cli(["export", sessionFile(), "--mode", "full", "--format", "html", "-o", noExt, "-q"]).status).toBe(0);
    expect(readFileSync(noExt, "utf8")).toContain("<!doctype html>");
  });

  it("export tightens an existing output file to 0600 (the mode only applies to a new file)", () => {
    const dir = mkdtempSync(join(tmpdir(), "as-perm-"));
    for (const name of ["share.json", "share.html"]) {
      const out = join(dir, name);
      writeFileSync(out, "old", { mode: 0o644 });
      chmodSync(out, 0o644); // umask may have narrowed it
      expect(cli(["export", sessionFile(), "--mode", "full", "-o", out, "-q"]).status).toBe(0);
      expect(statSync(out).mode & 0o777).toBe(0o600);
    }
  });

  it("export refuses to write an HTML file when the re-scan blocks the share, but still writes JSON for inspection", () => {
    // A session id skips content redaction, so a known secret there is caught only by the re-scan (see pipeline.vitest.ts).
    const secret = fake.envValue();
    const dir = mkdtempSync(join(tmpdir(), "as-blocked-"));
    const session = join(dir, "s.jsonl");
    writeFileSync(session, new ClaudeTranscript(secret).user("hi").toJsonl());
    const secrets = join(dir, "secrets.env");
    writeFileSync(secrets, `LEAKED=${secret}\n`);

    const html = join(dir, "out.html");
    const refused = cli(["export", session, "--mode", "brief", "--secrets-file", secrets, "-o", html, "-q"]);
    expect(refused.status).toBe(3);
    expect(refused.stderr).toContain("Refusing to write an HTML file");
    expect(existsSync(html)).toBe(false);

    const json = join(dir, "out.json");
    expect(cli(["export", session, "--mode", "brief", "--secrets-file", secrets, "-o", json, "-q"]).status).toBe(0);
    expect(existsSync(json)).toBe(true);
  });

  it("exports prompts-only content and accepts prompts in CLI help/report", () => {
    const out = join(mkdtempSync(join(tmpdir(), "as-prompts-")), "share.json");
    const file = sessionFile(fake.github());
    const r = cli(["export", file, "--mode", "prompts", "-o", out, "-q"]);
    expect(r.status).toBe(0);
    const json = readFileSync(out, "utf8");
    const shared = JSON.parse(json);
    expect(shared.mode).toBe("prompts");
    expect(shared.turns[0]).toMatchObject({ user: { text: "run it" }, steps: [], activity: { toolCalls: 1 } });
    expect(json).not.toContain("cat config");
    expect(json).not.toContain('"text":"done"');
    const report = cli(["report", file, "--mode", "prompts", "--json"]);
    expect(report.status).toBe(0);
    expect(JSON.parse(report.stdout)).toMatchObject({ mode: "prompts", clean: true });
    expect(cli(["publish", "--help"]).stdout).toContain("prompts");
  });

  it("--secrets-file values are redacted as known secrets", () => {
    const custom = `acmeint.${"k3v9".repeat(4)}`;
    const dir = mkdtempSync(join(tmpdir(), "as-sf-cli-"));
    const secrets = join(dir, "secrets.env");
    writeFileSync(secrets, `ACME_TOKEN=${custom}\n`);
    const session = sessionFile(custom);
    const without = cli(["report", session, "--mode", "full", "--json"]);
    expect(JSON.parse(without.stdout).counts["known-secret"]).toBeUndefined();
    const withFile = cli(["report", session, "--mode", "full", "--json", "--secrets-file", secrets]);
    expect(JSON.parse(withFile.stdout).counts["known-secret"]).toBe(1);
    expect(withFile.stdout).not.toContain(custom);
  });

  it.each(["serve", "demo"])("%s binds to 127.0.0.1 by default and documents --host 0.0.0.0", (command) => {
    const r = cli([command, "--help"]);
    expect(r.status).toBe(0);
    // Commander wraps help text to the terminal width.
    expect(r.stdout.replace(/\s+/g, " ")).toContain('--host <host> bind address (0.0.0.0 to expose on your network) (default: "127.0.0.1")');
  });

  it("delete refuses to run without confirmation when there is no TTY", () => {
    const r = cli(["delete", "https://overshare.link/s/#octo/5260b8cf9b1baae31a40717ac1ab5f08"], { PATH: "/nonexistent" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Refusing to delete without confirmation");
  });

  describe("delete updates shares.json", () => {
    const GIST = "5260b8cf9b1baae31a40717ac1ab5f08";
    const viewer = `https://overshare.link/s/#octo/${GIST}`;
    const record = (url: string, target: "gist" | "r2") => ({ url, mode: "brief", target, sharedAt: "2026-01-01T00:00:00Z" });

    /** A fake `gh` that succeeds (or fails) and logs its arguments. */
    function fakeGh(exit: number) {
      const bin = mkdtempSync(join(tmpdir(), "as-cli-bin-"));
      writeFileSync(join(bin, "gh"), `#!/bin/sh\necho "$@" >> "${join(bin, "calls")}"\n[ ${exit} = 0 ] || echo "gist not found" >&2\nexit ${exit}\n`);
      chmodSync(join(bin, "gh"), 0o755);
      return { bin, called: () => existsSync(join(bin, "calls")) };
    }
    function sharesFile(content: unknown) {
      const path = join(mkdtempSync(join(tmpdir(), "as-cli-shares-")), "shares.json");
      writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content));
      return path;
    }
    const seed = () => ({
      "pi:s1": [record(viewer, "gist"), record("https://overshare.link/s/#r2:AbCdEfGhIjKlMnOpQrStUv", "r2")],
      "claude-code:s2": [record(viewer, "gist")],
      "pi:s3": [record(`https://overshare.link/s/#octo/0123456789abcdef0123456789abcdef`, "gist")],
    });

    it("removes only the deleted share's records, whichever form was given", () => {
      for (const input of [viewer, `https://gist.github.com/octo/${GIST}`, GIST]) {
        const gh = fakeGh(0);
        const path = sharesFile(seed());
        const r = cli(["delete", input, "--yes"], { PATH: gh.bin, OVERSHARE_SHARES: path });
        expect(r.status).toBe(0);
        expect(r.stdout).toContain(`Deleted gist share ${GIST}.`);
        expect(r.stderr).not.toContain("warning");
        const after = JSON.parse(readFileSync(path, "utf8"));
        expect(Object.keys(after).sort()).toEqual(["pi:s1", "pi:s3"]);
        expect(after["pi:s1"]).toHaveLength(1);
        expect(after["pi:s1"][0].target).toBe("r2");
      }
    });

    it("leaves shares.json untouched when the remote delete fails or is declined", () => {
      const path = sharesFile(seed());
      const before = readFileSync(path, "utf8");
      const failing = cli(["delete", viewer, "--yes"], { PATH: fakeGh(1).bin, OVERSHARE_SHARES: path });
      expect(failing.status).toBe(1);
      expect(failing.stdout).not.toContain("Deleted");
      const declined = cli(["delete", viewer], { PATH: fakeGh(0).bin, OVERSHARE_SHARES: path });
      expect(declined.status).toBe(1); // no TTY: refuses before touching anything
      expect(readFileSync(path, "utf8")).toBe(before);
    });

    it("deleting an unrecorded share succeeds silently, even with no shares.json", () => {
      const gh = fakeGh(0);
      const missing = join(mkdtempSync(join(tmpdir(), "as-cli-none-")), "shares.json");
      const r = cli(["delete", GIST, "--yes"], { PATH: gh.bin, OVERSHARE_SHARES: missing });
      expect(r.status).toBe(0);
      expect(r.stderr).toBe("");
      expect(existsSync(missing)).toBe(false);
      const path = sharesFile(seed());
      const before = readFileSync(path, "utf8");
      expect(cli(["delete", "fedcba9876543210fedcba9876543210", "--yes"], { PATH: gh.bin, OVERSHARE_SHARES: path }).stderr).toBe("");
      expect(readFileSync(path, "utf8")).toBe(before);
    });

    it("warns but still succeeds when shares.json is corrupt", () => {
      const path = sharesFile("{nope");
      const r = cli(["delete", GIST, "--yes"], { PATH: fakeGh(0).bin, OVERSHARE_SHARES: path });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain(`Deleted gist share ${GIST}.`);
      expect(r.stderr).toContain("could not update shares.json");
    });
  });

  it("publish --json prints the result with the target as `publisher`", () => {
    const GIST = "5260b8cf9b1baae31a40717ac1ab5f08";
    const bin = mkdtempSync(join(tmpdir(), "as-cli-bin-"));
    writeFileSync(
      join(bin, "gh"),
      `#!/bin/sh\ncase "$1 $2" in\n  "gist create") echo "https://gist.github.com/octo/${GIST}" ;;\n  "api gists/${GIST}") echo octo ;;\nesac\nexit 0\n`,
    );
    chmodSync(join(bin, "gh"), 0o755);
    const shares = join(mkdtempSync(join(tmpdir(), "as-cli-shares-")), "shares.json");
    const r = cli(["publish", sessionFile(), "--yes", "--json"], { PATH: `${bin}:${process.env.PATH ?? ""}`, OVERSHARE_SHARES: shares });
    expect(r.status, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out).toMatchObject({ publisher: "gist", id: GIST, url: `https://gist.github.com/octo/${GIST}`, warnings: [] });
    expect(out.viewerUrl).toMatch(new RegExp(`#octo/${GIST}$`));
  });

  it("publish refuses --yes when the report is not clean (and never reaches gh)", () => {
    const r = cli(["publish", sessionFile(fake.github()), "--mode", "full", "--yes"], { PATH: "/nonexistent" });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("--yes only applies to clean reports");
  });
});

describe("cli browse", { timeout: 30_000 }, () => {
  it("refuses to run without an interactive terminal and points to `list`", () => {
    const r = cli(["browse"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("interactive terminal");
    expect(r.stderr).toContain("overshare list");
  });
});
