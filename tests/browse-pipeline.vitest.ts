/**
 * The whole path, nothing mocked but the upload: BrowserApp driven with raw keys over the real `Source`, which scans on
 * real worker threads. Fake secrets are planted in the transcript, in the environment and in a prompt; the payload
 * that reaches the publisher and everything that reaches the screen must not contain them.
 * Real timers: the workers are real threads, so the test waits for them.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BrowserApp } from "../src/browse/app.js";
import { plainText } from "../src/browse/kit.js";
import { workerRunner, type JobRunner } from "../src/browse/runner.js";
import { createSource } from "../src/browse/source.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { formatBytes } from "../src/format.js";
import type { Publisher, PublishPayload } from "../src/publish/types.js";
import { buildIndex } from "../src/sessions/index.js";
import { ccUsage, ClaudeTranscript, fake } from "./helpers.js";
import { KEY } from "./browse-helpers.js";

let dir: string;
const saved = { ...process.env };
const secrets = { github: "", anthropic: "", env: "", pem: "" };
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "browse-pipeline-"));
  process.env.AGENT_SHARE_SHARES = join(dir, "state", "shares.json");
  secrets.github = fake.github();
  secrets.anthropic = fake.anthropic();
  secrets.env = fake.envValue();
  secrets.pem = fake.pem();
  process.env.DEMO_SERVICE_TOKEN = secrets.env;
});
afterEach(() => {
  process.env = { ...saved };
});

const all = () => Object.values(secrets);
/** No secret, and none of its distinctive middle, in `text`. */
const leaks = (text: string) => all().filter((s) => text.includes(s) || text.includes(s.slice(8, 30)));

function indexed() {
  const projects = join(dir, "claude");
  mkdirSync(join(projects, "-home-me-work-app"), { recursive: true });
  const t = new ClaudeTranscript("sess-1", "/home/me/work/app")
    // On the first line, where the share title is derived from and its 80-character cut falls inside the key (ass-ahh1).
    .user(`please deploy the app, my key is ${secrets.anthropic}\nthanks`)
    .assistant("m1", [{ type: "tool_use", id: "b1", name: "Bash", input: { command: "cat .env" } }], ccUsage(10, 5))
    .toolResult("b1", `GITHUB_TOKEN=${secrets.github}\nDEMO_SERVICE_TOKEN=${secrets.env}\n${secrets.pem}`)
    .assistant("m2", [{ type: "text", text: "deployed; nothing else to do" }], ccUsage(10, 5));
  writeFileSync(join(projects, "-home-me-work-app", "sess-1.jsonl"), t.toJsonl());
  return buildIndex({ roots: { "claude-code": projects, pi: join(dir, "pi") }, cachePath: join(dir, "index.json") });
}

function recordingPublisher(): Publisher & { payloads: PublishPayload[] } {
  const payloads: PublishPayload[] = [];
  return {
    name: "fake",
    payloads,
    async publish(p) {
      payloads.push(p);
      return { publisher: "fake", id: "abc123", url: "https://gist.example/abc123", viewerUrl: "https://viewer.example/#abc123" };
    },
    async delete() {},
  };
}

/** Counts what the browser asked the workers to do, and what it cancelled. */
function spyRunner(): JobRunner & { runs: Array<{ kind: string; mode?: string; signal: AbortSignal }>; withhold?: { mode: string; until: Promise<void> } } {
  const inner = workerRunner();
  const runs: Array<{ kind: string; mode?: string; signal: AbortSignal }> = [];
  const spy: ReturnType<typeof spyRunner> = {
    runs,
    run(req, signal) {
      runs.push({ kind: req.kind, mode: req.kind === "review" ? req.mode : undefined, signal });
      const work = inner.run(req, signal);
      // Deliver the answer of this mode late, after the browser has moved on, even though it was cancelled.
      return spy.withhold && req.kind === "review" && req.mode === spy.withhold.mode ? work.then(async (r) => (await spy.withhold!.until, r)) : work;
    },
    close: () => inner.close(),
  };
  return spy;
}

/**
 * Only the publish dialog's body: the list, the viewer and the dialog's own heading (the session's local title) show the
 * user's own, unredacted transcript by design; what the review reports must not.
 */
function dialogOf(screen: string): string {
  const lines = screen.split("\n");
  const top = lines.findIndex((l) => l.includes("╭─ Publish"));
  if (top < 0) return "";
  const from = lines[top]!.indexOf("╭─ Publish");
  const to = lines[top]!.indexOf("╮", from) + 1;
  const bottom = lines.findIndex((l, i) => i > top && l.includes("╰"));
  return lines.slice(top + 2, bottom + 1).map((l) => l.slice(from, to)).join("\n"); // skip the border and the heading
}

function start() {
  const sessions = indexed();
  const publisher = recordingPublisher();
  const runner = spyRunner();
  const source = createSource({ config: DEFAULT_CONFIG, sessions, publisher: () => publisher, runner });
  const app = new BrowserApp(source, {});
  let quit = false;
  app.onQuit = () => void (quit = true);
  app.attach(() => 40, () => {});
  const screen = () => app.render(130).map(plainText).join("\n");
  const waitFor = async (text: string | RegExp, ms = 8_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const s = screen();
      if (typeof text === "string" ? s.includes(text) : text.test(s)) return s;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`timed out waiting for ${text}; screen:\n${screen()}`);
  };
  const seen: string[] = [];
  const key = (k: string) => {
    app.handleInput(k);
    seen.push(screen());
  };
  return { app, publisher, runner, source, screen, waitFor, key, seen, quit: () => quit };
}

describe("browse over the real source and worker threads", () => {
  it("reviews and publishes through the async path; neither the screen nor the upload ever holds a planted secret", async () => {
    const t = start();
    t.key("p");
    const scanning = t.screen();
    expect(scanning).toContain("scanning for secrets…"); // the dialog is up before the scan has answered
    const done = await t.waitFor("known values:");
    expect(done).toMatch(/\d+ redactions?/);
    t.key(KEY.enter);
    expect(t.screen()).toContain("Publish brief to");
    expect(t.publisher.payloads).toEqual([]); // nothing sent before the explicit y
    t.key("y");
    await t.waitFor("✓ published");
    expect(t.publisher.payloads).toHaveLength(1);
    const { content } = t.publisher.payloads[0]!;
    expect(leaks(content)).toEqual([]);
    expect(content).toContain("[REDACTED");
    // What the dialog said about the payload is the payload that went out.
    expect(done).toContain(`${formatBytes(Buffer.byteLength(content))} payload`);
    expect(JSON.parse(content).mode).toBe("brief");
    const dialogs = [...t.seen, t.screen()].map(dialogOf).filter(Boolean);
    expect(dialogs.length).toBeGreaterThan(2);
    for (const frame of dialogs) expect(leaks(frame)).toEqual([]);
  });

  it("opens the viewer with a loading state, then shows the session and the redaction status of a brief share", async () => {
    const t = start();
    t.key(KEY.enter);
    expect(t.screen()).toContain("reading the session…");
    const text = await t.waitFor(/brief share/);
    expect(text).toContain("deployed; nothing else to do");
    // The viewer shows the local transcript as it is; what it says about the redaction check is only counts and rule names.
    const status = text.split("\n").filter((l) => /brief share|redaction/.test(l)).join("\n");
    expect(status).toMatch(/brief share/);
    expect(leaks(status)).toEqual([]);
    expect(t.runner.runs.map((r) => r.kind).sort()).toEqual(["review", "view"]);
  });

  it("a mode switched mid-scan cancels the old scan and publishes only the mode on screen", async () => {
    const t = start();
    let release!: () => void;
    t.runner.withhold = { mode: "brief", until: new Promise<void>((r) => (release = r)) };
    t.key("p");
    await new Promise((r) => setTimeout(r, 250)); // past the debounce: the brief scan is running (and its answer is held back)
    expect(t.runner.runs.map((r) => r.mode)).toEqual(["brief"]);
    t.key("1"); // full
    expect(t.runner.runs[0]!.signal.aborted).toBe(true);
    release(); // the brief answer arrives now, late, though it was cancelled
    await t.waitFor(/\d+ redactions?/);
    expect(t.screen()).toContain("› 1 full");
    await new Promise((r) => setTimeout(r, 50));
    expect(t.screen()).toContain("› 1 full");
    t.key(KEY.enter);
    expect(t.screen()).toContain("Publish full to");
    t.key("y");
    await t.waitFor("✓ published");
    const { content } = t.publisher.payloads[0]!;
    expect(JSON.parse(content).mode).toBe("full");
    expect(leaks(content)).toEqual([]);
    expect(t.publisher.payloads).toHaveLength(1);
  });

  it("the viewer's brief check and the dialog's brief scan are one scan, and closing the dialog leaves the viewer's check alone", async () => {
    const t = start();
    t.key(KEY.enter);
    await new Promise((r) => setTimeout(r, 200));
    t.key("p");
    await new Promise((r) => setTimeout(r, 200));
    expect(t.runner.runs.filter((r) => r.mode === "brief")).toHaveLength(1);
    t.key(KEY.esc); // close the dialog; the viewer is still waiting for the same scan
    await t.waitFor(/brief share/);
  });

  it("quitting while a session is being read stops the workers and leaves nothing running", async () => {
    const t = start();
    t.key(KEY.enter);
    t.app.quit();
    expect(t.quit()).toBe(true);
    expect(t.runner.runs.every((r) => r.signal.aborted)).toBe(true);
    await new Promise((r) => setTimeout(r, 100)); // an unhandled rejection from a stopped worker would fail the run
  });
});
