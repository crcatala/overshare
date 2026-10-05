import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseSession } from "../src/harnesses/index.js";
import { PublishFlow } from "../src/browse/flow.js";
import { viewFromSession } from "../src/browse/job.js";
import type { JobRequest } from "../src/browse/job.js";
import { inlineRunner, isAbort, type JobRunner } from "../src/browse/runner.js";
import { createSource } from "../src/browse/source.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { PromptsUnavailableError } from "../src/modes.js";
import type { ShareMode } from "../src/schema.js";
import { publishPrepared } from "../src/publish/index.js";
import type { Publisher, PublishPayload } from "../src/publish/types.js";
import { buildIndex } from "../src/sessions/index.js";
import { loadShares, sharesFor } from "../src/sessions/shares.js";
import { prepareShare } from "../src/pipeline.js";
import { loadSubagentFiles } from "../src/harnesses/claude-code/subagent-files.js";
import { ccUsage, ClaudeTranscript, fake, PiTranscript } from "./helpers.js";
import { SUBAGENT_FIXTURES_ROOT } from "./subagent-fixtures.js";

let dir: string;
const saved = { ...process.env };
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "browse-src-"));
  process.env.OVERSHARE_SHARES = join(dir, "state", "shares.json");
});
afterEach(() => {
  process.env = { ...saved };
});

function recordingPublisher(): Publisher & { payloads: PublishPayload[] } {
  const payloads: PublishPayload[] = [];
  return {
    payloads,
    async publish(p) {
      payloads.push(p);
      return { id: "abc123", url: "https://gist.example/abc123", viewerUrl: "https://viewer.example/#abc123" };
    },
    async delete() {},
  };
}

/** Write one Claude session (optionally leaking a fake secret in a tool result) and index it. */
function indexed(secret?: string) {
  const projects = join(dir, "claude");
  mkdirSync(join(projects, "-home-me-work-app"), { recursive: true });
  const file = join(projects, "-home-me-work-app", "sess-1.jsonl");
  const t = new ClaudeTranscript("sess-1", "/home/me/work/app")
    .user("deploy the app")
    .assistant("m1", [{ type: "tool_use", id: "b1", name: "Bash", input: { command: "cat .env" } }], ccUsage(10, 5))
    .toolResult("b1", secret ? `GITHUB_TOKEN=${secret}` : "ok")
    .assistant("m2", [{ type: "text", text: "done" }], ccUsage(10, 5));
  writeFileSync(file, t.toJsonl());
  const sessions = buildIndex({ roots: { "claude-code": projects, pi: join(dir, "pi") }, cachePath: join(dir, "index.json") });
  return { file, sessions, session: sessions[0]! };
}

const live = new AbortController();
/** Review and then publish exactly that review, the way the browser's flow does. */
async function reviewAndPublish(source: ReturnType<typeof createSource>, session: Parameters<typeof source.view>[0], mode: ShareMode, opts: { suspiciousConfirmed?: boolean } = {}) {
  const review = await source.review(session, mode, "gist", live.signal);
  return { review, out: await source.publish(session, mode, { target: "gist", reviewId: review.id, ...opts }) };
}

/** Anything but tab and newline: the terminal must never be handed these. */
const CONTROLS = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/;

describe("viewFromSession", () => {
  const transcript = () =>
    new ClaudeTranscript()
      .user("<command-name>/review</command-name>\n<command-args>the diff</command-args>")
      .user("expansion", { isMeta: true })
      .assistant("m1", [{ type: "thinking", thinking: "hmm" }, { type: "text", text: "Looking.\nSecond line" }, { type: "tool_use", id: "t1", name: "Bash", input: { command: "npm test" } }], ccUsage(1, 1))
      .toolResult("t1", "boom", {}, true)
      .user("<pasted_content id=\"a1\">fix it please</pasted_content>")
      .assistant("m2", [{ type: "text", text: "Fixed." }], ccUsage(1, 1))
      .toJsonl();

  it("turns a parsed session into ordered rows with one-line labels and full bodies", () => {
    const view = viewFromSession(parseSession(transcript(), "claude-code").session);
    expect(view.items.map((i) => `${i.turn}:${i.kind}`)).toEqual(["1:user", "1:thinking", "1:assistant", "1:tool", "2:user", "2:assistant"]);
    const [prompt, , reply, tool, pasted] = view.items;
    expect(prompt).toMatchObject({ label: "/review the diff", meta: "command" });
    expect(reply).toMatchObject({ label: "Looking.", body: "Looking.\nSecond line" });
    expect(tool).toMatchObject({ kind: "tool", error: true, meta: "Bash" });
    expect(tool!.body).toContain("npm test");
    expect(tool!.body).toContain("boom");
    // Paste wrappers are UI noise, not content.
    expect(pasted!.label).toBe("fix it please");
    expect(pasted!.body).toBe("fix it please");
  });

  it("counts tools for the header and formats the stats", () => {
    const view = viewFromSession(parseSession(transcript(), "claude-code").session);
    expect(view.tools).toEqual({ Bash: 1 });
    expect(view.turns).toBe(2);
    expect(view.stats.toolCalls).toBe(1);
  });

  it("strips terminal control sequences from every transcript string it returns", () => {
    const evil = "\x1b]52;c;ZXZpbA==\x07\x1b]0;pwned\x07\x1b[2J\x1b[31m\x9b31m\rtext";
    const t = new ClaudeTranscript()
      .user(`prompt ${evil}`)
      .assistant("m1", [{ type: "text", text: `reply ${evil}` }, { type: "tool_use", id: "t1", name: `Bash${evil}`, input: { command: `echo ${evil}` } }], ccUsage(1, 1))
      .toolResult("t1", `out ${evil}`)
      .toJsonl();
    const view = viewFromSession(parseSession(t, "claude-code").session);
    const strings = [...view.items.flatMap((it) => [it.label, it.body, it.meta ?? ""]), ...Object.keys(view.tools)];
    for (const text of strings) expect(text).not.toMatch(CONTROLS);
    expect(view.items[0]!.body).toBe("prompt 31mtext");
    expect(view.items.find((i) => i.kind === "tool")!.body).toContain("out 31mtext");
  });

  it("flags the blocks that are a tool's result, so a search can leave them out", () => {
    const view = viewFromSession(parseSession(transcript(), "claude-code").session);
    const tool = view.items.find((i) => i.kind === "tool")!;
    // the command is the call; the "error" heading and the output under it are the result
    expect(tool.blocks!.map((b) => `${b.type}${b.output ? ":output" : ""}`)).toEqual(["code", "label:output", "code:output"]);
    expect(view.items.filter((i) => i.kind !== "tool").every((i) => !i.blocks)).toBe(true);
  });

  it("truncates huge tool output instead of carrying it all", () => {
    const t = new ClaudeTranscript()
      .user("dump it")
      .assistant("m1", [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "cat big" } }], ccUsage(1, 1))
      .toolResult("t1", "x".repeat(50_000))
      .toJsonl();
    const tool = viewFromSession(parseSession(t, "claude-code").session).items.find((i) => i.kind === "tool")!;
    expect(tool.body.length).toBeLessThan(6_000);
    expect(tool.body).toContain("more characters");
  });
});

describe("createSource", () => {
  it("reviews with the real pipeline: secrets are found, redacted, and never in the summary", async () => {
    const secret = fake.github();
    const { sessions, session } = indexed(secret);
    const source = createSource({ config: DEFAULT_CONFIG, sessions });
    const review = await source.review(session, "full", "gist", live.signal);
    expect(review.clean).toBe(false);
    expect(review.findings.length).toBeGreaterThan(0);
    expect(JSON.stringify(review)).not.toContain(secret);
    expect((await source.review(indexed().session, "full", "gist", live.signal)).clean).toBe(true);
  });

  it("publishes exactly the payload that was reviewed, even if the session file changes afterwards", async () => {
    const { file, sessions, session } = indexed();
    const publisher = recordingPublisher();
    const source = createSource({ config: DEFAULT_CONFIG, sessions, publisher: () => publisher });
    const first = await source.review(session, "brief", "gist", live.signal);
    // The session keeps growing (or is edited) after the user looked at the review.
    writeFileSync(file, `${readFileSync(file, "utf8")}${JSON.stringify({ type: "user", uuid: "late", parentUuid: null, sessionId: "sess-1", timestamp: "2026-01-02T00:00:00Z", message: { role: "user", content: "a late prompt nobody reviewed" } })}\n`);
    await source.publish(session, "brief", { target: "gist", reviewId: first.id });
    expect(publisher.payloads).toHaveLength(1);
    expect(publisher.payloads[0]!.content).not.toContain("a late prompt nobody reviewed");
    expect(Buffer.byteLength(publisher.payloads[0]!.content)).toBe(first.bytes);
    // The reviewed payload is spent. A second publish must not quietly re-scan the (changed) file and upload
    // content nobody looked at: it has to be reviewed again first.
    await expect(source.publish(session, "brief", { target: "gist", reviewId: first.id })).rejects.toThrow(/review it again/);
    expect(publisher.payloads).toHaveLength(1);
    await reviewAndPublish(source, session, "brief");
    expect(publisher.payloads[1]!.content).toContain("a late prompt nobody reviewed");
  });

  it("never uploads a payload that was evicted from the review cache", async () => {
    const { file, sessions, session } = indexed();
    const publisher = recordingPublisher();
    const source = createSource({ config: DEFAULT_CONFIG, sessions, publisher: () => publisher, keepPrepared: 1 });
    const brief = await source.review(session, "brief", "gist", live.signal);
    await source.review(session, "full", "gist", live.signal); // evicts the brief review
    writeFileSync(file, `${readFileSync(file, "utf8")}${JSON.stringify({ type: "user", uuid: "late", parentUuid: null, sessionId: "sess-1", timestamp: "2026-01-02T00:00:00Z", message: { role: "user", content: "unreviewed late prompt" } })}\n`);
    await expect(source.publish(session, "brief", { target: "gist", reviewId: brief.id })).rejects.toThrow(/review it again/);
    expect(publisher.payloads).toEqual([]);
  });

  it("publishing without any review uploads nothing", async () => {
    const { sessions, session } = indexed();
    const publisher = recordingPublisher();
    const source = createSource({ config: DEFAULT_CONFIG, sessions, publisher: () => publisher });
    await expect(source.publish(session, "brief", { target: "gist", reviewId: "never-reviewed" })).rejects.toThrow(/review it again/);
    expect(publisher.payloads).toEqual([]);
  });

  it("uploads the redacted payload, never the raw secret", async () => {
    const secret = fake.github();
    const { sessions, session } = indexed(secret);
    const publisher = recordingPublisher();
    const source = createSource({ config: DEFAULT_CONFIG, sessions, publisher: () => publisher });
    await reviewAndPublish(source, session, "full");
    expect(publisher.payloads[0]!.content).not.toContain(secret);
    expect(publisher.payloads[0]!.description).toContain("overshare:");
  });

  it("records the share in shares.json and in memory so the list marks it immediately", async () => {
    const { sessions, session } = indexed();
    const source = createSource({ config: DEFAULT_CONFIG, sessions, publisher: () => recordingPublisher() });
    expect(sharesFor(source.shares, "claude-code", "sess-1")).toHaveLength(0);
    const { out } = await reviewAndPublish(source, session, "brief");
    expect(out.url).toBe("https://viewer.example/#abc123");
    expect(sharesFor(source.shares, "claude-code", "sess-1").map((r) => r.url)).toEqual(["https://viewer.example/#abc123"]);
    const onDisk = loadShares();
    expect(onDisk["claude-code:sess-1"]).toHaveLength(1);
    expect(onDisk["claude-code:sess-1"]![0]).toMatchObject({ mode: "brief", target: "gist" });
  });

  it("does not hide an upload that succeeded when shares.json cannot be written", async () => {
    const { sessions, session } = indexed();
    writeFileSync(join(dir, "blocker"), "a file, not a directory");
    process.env.OVERSHARE_SHARES = join(dir, "blocker", "shares.json");
    const source = createSource({ config: DEFAULT_CONFIG, sessions, publisher: () => recordingPublisher() });
    const { out } = await reviewAndPublish(source, session, "brief");
    expect(out.url).toBe("https://viewer.example/#abc123");
    expect(out.warnings.join(" ")).toContain("could not record this share");
    expect(sharesFor(source.shares, "claude-code", "sess-1")).toHaveLength(1); // still marked in this run
  });

  it("refuses prompts mode for a legacy pi session instead of guessing", async () => {
    const pi = join(dir, "pi", "--home-me-work-app--");
    mkdirSync(pi, { recursive: true });
    const t = new PiTranscript("01a0aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee", "/home/me/work/app").user("a prompt with no recorded authored input");
    writeFileSync(join(pi, "2026-01-01T00-00-00-000Z_01a0aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee.jsonl"), t.toJsonl());
    const sessions = buildIndex({ roots: { "claude-code": join(dir, "none"), pi: join(dir, "pi") }, cachePath: join(dir, "index.json") });
    const source = createSource({ config: DEFAULT_CONFIG, sessions });
    await expect(source.review(sessions[0]!, "prompts", "gist", live.signal)).rejects.toThrow(PromptsUnavailableError);
    expect((await source.review(sessions[0]!, "brief", "gist", live.signal)).mode).toBe("brief"); // other modes are unaffected
  });

  it("reports unusable publish targets before anything is scanned or sent", () => {
    const { sessions } = indexed();
    delete process.env.OVERSHARE_R2_ACCESS_KEY_ID;
    delete process.env.OVERSHARE_R2_SECRET_ACCESS_KEY;
    const r2 = createSource({ config: { ...DEFAULT_CONFIG, target: "r2" }, sessions });
    expect(r2.preflight("r2").error).toMatch(/r2/i);
    expect(r2.target).toBe("r2");
    const gist = createSource({ config: DEFAULT_CONFIG, sessions });
    expect(gist.preflight("gist").error).toBeUndefined();
    expect(gist.target).toBe("gist");
  });

  it("view reads the local transcript", async () => {
    const { sessions, session } = indexed();
    const view = await createSource({ config: DEFAULT_CONFIG, sessions }).view(session, live.signal);
    expect(view.items[0]).toMatchObject({ kind: "user", label: "deploy the app" });
    expect(view.tools).toEqual({ Bash: 1 });
  });
});

describe("review requests", () => {
  /** A runner whose jobs finish when the test says so; it records each job's signal and whether it was cancelled. */
  function heldRunner() {
    const jobs: Array<{ req: JobRequest; signal: AbortSignal; finish(): void }> = [];
    const inner = inlineRunner;
    const runner: JobRunner = {
      run(req, signal) {
        return new Promise((resolve, reject) => {
          const job = { req, signal, finish: () => inner.run(req, new AbortController().signal).then(resolve, reject) };
          jobs.push(job);
          signal.addEventListener("abort", () => reject(Object.assign(new Error("cancelled"), { name: "AbortError" })), { once: true });
        });
      },
      close() {},
    };
    return { runner, jobs };
  }

  it("callers waiting for the same review share one scan; it stops only when nobody is waiting", async () => {
    const { sessions, session } = indexed();
    const { runner, jobs } = heldRunner();
    const source = createSource({ config: DEFAULT_CONFIG, sessions, runner });
    const a = new AbortController();
    const b = new AbortController();
    const first = source.review(session, "brief", "gist", a.signal).catch((e: unknown) => e);
    const second = source.review(session, "brief", "gist", b.signal);
    expect(jobs).toHaveLength(1);
    a.abort();
    expect(isAbort(await first)).toBe(true);
    expect(jobs[0]!.signal.aborted).toBe(false); // b still wants it
    jobs[0]!.finish();
    const review = await second;
    expect(review.mode).toBe("brief");
    // Done: the same review again is the cached one, same id, no new scan.
    expect((await source.review(session, "brief", "gist", live.signal)).id).toBe(review.id);
    expect(jobs).toHaveLength(1);

    const c = new AbortController();
    const abandoned = source.review(session, "full", "gist", c.signal).catch((e: unknown) => e);
    c.abort();
    expect(isAbort(await abandoned)).toBe(true);
    expect(jobs[1]!.signal.aborted).toBe(true); // nobody left waiting: the scan is cancelled
  });

  it("a review that finishes after every waiter left is not shown to anyone, and a later review starts fresh when it was cancelled", async () => {
    const { sessions, session } = indexed();
    const { runner, jobs } = heldRunner();
    const source = createSource({ config: DEFAULT_CONFIG, sessions, runner });
    const c = new AbortController();
    const gone = source.review(session, "brief", "gist", c.signal).catch((e: unknown) => e);
    c.abort();
    expect(isAbort(await gone)).toBe(true);
    const again = source.review(session, "brief", "gist", live.signal);
    expect(jobs).toHaveLength(2); // the cancelled scan is not reused
    jobs[1]!.finish();
    expect((await again).mode).toBe("brief");
  });

  it("a retry made in the same tick as the abort starts a fresh scan instead of joining the cancelled one", async () => {
    const { sessions, session } = indexed();
    const { runner, jobs } = heldRunner();
    const source = createSource({ config: DEFAULT_CONFIG, sessions, runner });
    const a = new AbortController();
    const cancelled = source.review(session, "brief", "gist", a.signal).catch((e: unknown) => e);
    a.abort();
    const retry = source.review(session, "brief", "gist", live.signal); // no await in between: the cancelled scan has not settled yet
    expect(jobs).toHaveLength(2);
    expect(jobs[0]!.signal.aborted).toBe(true);
    expect(jobs[1]!.signal.aborted).toBe(false);
    jobs[1]!.finish();
    expect((await retry).mode).toBe("brief");
    expect(isAbort(await cancelled)).toBe(true);
  });

  it("a caller whose signal is already aborted starts nothing and leaves nothing waiting", async () => {
    const { sessions, session } = indexed();
    const { runner, jobs } = heldRunner();
    const source = createSource({ config: DEFAULT_CONFIG, sessions, runner });
    const dead = new AbortController();
    dead.abort();
    expect(isAbort(await source.review(session, "brief", "gist", dead.signal).catch((e: unknown) => e))).toBe(true);
    expect(jobs).toHaveLength(0);
    // It must not have counted as a waiter of a later scan either: when that scan's only real caller leaves, it stops.
    const b = new AbortController();
    const waiting = source.review(session, "brief", "gist", b.signal).catch((e: unknown) => e);
    const alsoDead = source.review(session, "brief", "gist", dead.signal).catch((e: unknown) => e);
    b.abort();
    expect(isAbort(await waiting)).toBe(true);
    expect(isAbort(await alsoDead)).toBe(true);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.signal.aborted).toBe(true);
  });

  it("publish takes the id of the review it was shown: another review's id, or another mode's, uploads nothing", async () => {
    const { sessions, session } = indexed();
    const publisher = recordingPublisher();
    const source = createSource({ config: DEFAULT_CONFIG, sessions, publisher: () => publisher });
    const brief = await source.review(session, "brief", "gist", live.signal);
    const full = await source.review(session, "full", "gist", live.signal);
    expect(brief.id).not.toBe(full.id);
    await expect(source.publish(session, "brief", { target: "gist", reviewId: full.id })).rejects.toThrow(/review it again/);
    await expect(source.publish(session, "full", { target: "gist", reviewId: brief.id })).rejects.toThrow(/review it again/);
    expect(publisher.payloads).toEqual([]);
    await source.publish(session, "brief", { target: "gist", reviewId: brief.id });
    expect(publisher.payloads).toHaveLength(1);
    expect(JSON.parse(publisher.payloads[0]!.content).mode).toBe("brief");
  });

  it("close() cancels every read and scan in flight", async () => {
    const { sessions, session } = indexed();
    const { runner, jobs } = heldRunner();
    const source = createSource({ config: DEFAULT_CONFIG, sessions, runner });
    const settled = [source.view(session, live.signal), source.review(session, "brief", "gist", live.signal)].map((p) => p.catch((e: unknown) => e));
    source.close();
    expect((await Promise.all(settled)).every(isAbort)).toBe(true);
    expect(jobs.every((j) => j.signal.aborted)).toBe(true);
  });

  it("never uploads bytes that differ from the review: the payload is checked against the reviewed size", async () => {
    const { sessions, session } = indexed();
    const publisher = recordingPublisher();
    const real = inlineRunner;
    // A runner that corrupts the payload after the scan (as a bug in the transfer would).
    const corrupting: JobRunner = {
      close() {},
      async run(req, signal) {
        const result = await real.run(req, signal);
        return result.kind === "review" ? { ...result, payload: new TextEncoder().encode(`${new TextDecoder().decode(result.payload)} tampered`) } : result;
      },
    };
    const source = createSource({ config: DEFAULT_CONFIG, sessions, publisher: () => publisher, runner: corrupting });
    const review = await source.review(session, "brief", "gist", live.signal);
    await expect(source.publish(session, "brief", { target: "gist", reviewId: review.id })).rejects.toThrow(/does not match its review/);
    expect(publisher.payloads).toEqual([]);
  });
});

describe("publishPrepared", () => {
  it("is what `publish` and the browser share: uploads, then records the share", async () => {
    const { file } = indexed();
    const { prepareShare } = await import("../src/pipeline.js");
    const prepared = prepareShare(readFileSync(file, "utf8"), { mode: "minimal", config: DEFAULT_CONFIG });
    const publisher = recordingPublisher();
    const { result, warnings } = await publishPrepared(publisher, DEFAULT_CONFIG, "gist", prepared);
    expect(result.viewerUrl).toBe("https://viewer.example/#abc123");
    expect(warnings).toEqual([]);
    expect(loadShares()["claude-code:sess-1"]![0]).toMatchObject({ url: "https://viewer.example/#abc123", mode: "minimal" });
  });
});

describe("subagent transcripts (parity with the CLI)", () => {
  const sessionWithSubagents = () => {
    const sessions = buildIndex({ roots: { "claude-code": SUBAGENT_FIXTURES_ROOT, pi: join(dir, "pi") }, cachePath: join(dir, "fixtures-index.json") });
    // Three parallel foreground subagents, whose usage only the subagent files supply.
    const session = sessions.find((s) => s.id.startsWith("bf3c7500"));
    expect(session, "the parallel-subagents fixture session").toBeDefined();
    return { sessions, session: session! };
  };

  it("the viewer shows what the subagent files add, like the CLI", async () => {
    const { sessions, session } = sessionWithSubagents();
    const raw = readFileSync(session.path, "utf8");
    const withFiles = parseSession(raw, "claude-code", { subagentFiles: loadSubagentFiles(session.path) }).session;
    const without = parseSession(raw, "claude-code").session;
    // The subagent files only add usage to the subagent steps, which the viewer does not show (it used to also
    // fill the parallel results that the main transcript's sibling chain hid, which is now read from the main file).
    expect(JSON.stringify(withFiles.turns)).not.toBe(JSON.stringify(without.turns)); // the fixture really exercises the loader
    expect(viewFromSession(withFiles)).toEqual(viewFromSession(without));
    expect(await createSource({ config: DEFAULT_CONFIG, sessions }).view(session, live.signal)).toEqual(viewFromSession(withFiles));
  });

  it("the reviewed payload is byte-for-byte what `overshare publish` would prepare", async () => {
    const { sessions, session } = sessionWithSubagents();
    const raw = readFileSync(session.path, "utf8");
    const cli = prepareShare(raw, { mode: "full", config: DEFAULT_CONFIG, harness: "claude-code", subagentFiles: loadSubagentFiles(session.path) });
    const withoutSubagents = prepareShare(raw, { mode: "full", config: DEFAULT_CONFIG, harness: "claude-code" });
    expect(Buffer.byteLength(cli.json)).not.toBe(Buffer.byteLength(withoutSubagents.json)); // the fixture really exercises the loader
    const review = await createSource({ config: DEFAULT_CONFIG, sessions }).review(session, "full", "gist", live.signal);
    expect(review.bytes).toBe(Buffer.byteLength(cli.json));
  });
});

describe("publish target (ass-ihnf)", () => {
  const r2Config = { ...DEFAULT_CONFIG, viewerUrlSource: "config" as const, r2: { bucket: "b", publicUrl: "https://shares.example.com" } };

  /** The credentials come from either spelling of the variables, and a developer's shell may have one. */
  const noR2Credentials = () => {
    for (const name of ["OVERSHARE_R2_ACCESS_KEY_ID", "OVERSHARE_R2_SECRET_ACCESS_KEY", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"]) delete process.env[name];
  };

  /** One publisher fake per target, so a test sees which one an upload reached. */
  function publishers() {
    const make = (name: string): Publisher & { payloads: PublishPayload[] } => {
      const payloads: PublishPayload[] = [];
      return {
        payloads,
        async publish(p) {
          payloads.push(p);
          return { id: `${name}-id`, url: `https://${name}.example/id`, viewerUrl: `https://viewer.example/#${name}` };
        },
        async delete() {},
      };
    };
    const byTarget = { gist: make("gist"), r2: make("r2") };
    return { ...byTarget, factory: (_config: unknown, target: "gist" | "r2") => byTarget[target] };
  }

  /** Counts the scans a source starts, so a cache hit and a new scan can be told apart. */
  function countingRunner() {
    const reviews: string[] = [];
    const runner: JobRunner = {
      run(req, signal) {
        if (req.kind === "review") reviews.push(req.mode);
        return inlineRunner.run(req, signal);
      },
      close() {},
    };
    return { runner, reviews };
  }

  it("starts on the configured target", () => {
    const { sessions } = indexed();
    expect(createSource({ config: DEFAULT_CONFIG, sessions }).target).toBe("gist");
    expect(createSource({ config: { ...r2Config, target: "r2" }, sessions }).target).toBe("r2");
  });

  it("keys the cached review on the target: switching starts a new scan, and each target keeps its own review", async () => {
    const { sessions, session } = indexed();
    const { runner, reviews } = countingRunner();
    const source = createSource({ config: r2Config, sessions, runner });
    const gist = await source.review(session, "brief", "gist", live.signal);
    const r2 = await source.review(session, "brief", "r2", live.signal);
    expect(reviews).toEqual(["brief", "brief"]); // not served from the gist review
    expect(r2.id).not.toBe(gist.id);
    expect([gist.target, r2.target]).toEqual(["gist", "r2"]);
    expect((await source.review(session, "brief", "gist", live.signal)).id).toBe(gist.id); // still cached for its own target
    expect(reviews).toHaveLength(2);
  });

  it("uploads to the target it was reviewed for, and records that target, whatever the default is", async () => {
    const { sessions, session } = indexed();
    const p = publishers();
    const config = { ...r2Config, target: "gist" as const };
    const source = createSource({ config, sessions, publisher: p.factory });
    const review = await source.review(session, "brief", "r2", live.signal);
    const out = await source.publish(session, "brief", { target: "r2", reviewId: review.id });
    expect(out.url).toBe("https://viewer.example/#r2");
    expect(p.r2.payloads).toHaveLength(1);
    expect(p.gist.payloads).toEqual([]);
    expect(Buffer.byteLength(p.r2.payloads[0]!.content)).toBe(review.bytes);
    // The record that marks the session shared names r2, on disk and in memory.
    expect(loadShares()["claude-code:sess-1"]).toEqual([expect.objectContaining({ url: "https://viewer.example/#r2", target: "r2" })]);
    expect(sharesFor(source.shares, "claude-code", "sess-1").map((r) => r.target)).toEqual(["r2"]);
    // A per-publish override: neither the source's default nor the config moved.
    expect(source.target).toBe("gist");
    expect(config.target).toBe("gist");
  });

  it("uploads to gist when gist is chosen on a source whose default is r2", async () => {
    const { sessions, session } = indexed();
    const p = publishers();
    const source = createSource({ config: { ...r2Config, target: "r2" }, sessions, publisher: p.factory });
    const review = await source.review(session, "brief", "gist", live.signal);
    await source.publish(session, "brief", { target: "gist", reviewId: review.id });
    expect(p.gist.payloads).toHaveLength(1);
    expect(p.r2.payloads).toEqual([]);
    expect(sharesFor(source.shares, "claude-code", "sess-1").map((r) => r.target)).toEqual(["gist"]);
  });

  it("never uploads a review made for one target to another", async () => {
    const { sessions, session } = indexed();
    const p = publishers();
    const source = createSource({ config: r2Config, sessions, publisher: p.factory });
    const gist = await source.review(session, "brief", "gist", live.signal);
    await expect(source.publish(session, "brief", { target: "r2", reviewId: gist.id })).rejects.toThrow(/review it again/);
    const r2 = await source.review(session, "brief", "r2", live.signal);
    await expect(source.publish(session, "brief", { target: "gist", reviewId: r2.id })).rejects.toThrow(/review it again/);
    expect([p.gist.payloads, p.r2.payloads]).toEqual([[], []]);
    await source.publish(session, "brief", { target: "r2", reviewId: r2.id }); // the matching pair still works
    expect(p.r2.payloads).toHaveLength(1);
  });

  it("preflight follows the target: the default-viewerUrl warning is R2's, and a target that is not set up says what is missing", () => {
    const { sessions } = indexed();
    noR2Credentials();
    const source = createSource({ config: { ...DEFAULT_CONFIG, viewerUrlSource: "default" }, sessions });
    expect(source.preflight("gist")).toEqual({ warnings: [] });
    const r2 = source.preflight("r2");
    expect(r2.error).toContain('needs an "r2" section');
    expect(r2.warnings[0]).toMatch(/viewerUrl is the built-in default/);
    // With the section but no credentials, it is the credentials that are missing.
    const noCredentials = createSource({ config: r2Config, sessions }).preflight("r2");
    expect(noCredentials.error).toMatch(/R2 credentials missing/);
    process.env.OVERSHARE_R2_ACCESS_KEY_ID = "id";
    process.env.OVERSHARE_R2_SECRET_ACCESS_KEY = "secret";
    expect(createSource({ config: r2Config, sessions }).preflight("r2")).toEqual({ warnings: [] });
  });

  it("an unconfigured target refuses the publish with its reason and uploads nothing", async () => {
    const { sessions, session } = indexed();
    noR2Credentials();
    const source = createSource({ config: DEFAULT_CONFIG, sessions });
    const review = await source.review(session, "brief", "r2", live.signal); // reviewing needs no destination
    await expect(source.publish(session, "brief", { target: "r2", reviewId: review.id })).rejects.toThrow(/needs an "r2" section/);
    expect(sharesFor(source.shares, "claude-code", "sess-1")).toEqual([]);
  });

  it("a review the source evicted while the user explored other modes and targets is scanned again, not stuck", async () => {
    vi.useFakeTimers();
    try {
      const { sessions, session } = indexed();
      const p = publishers();
      // 2 targets x 4 modes are more slots than the source keeps: visiting them all evicts the first.
      const source = createSource({ config: r2Config, sessions, publisher: p.factory, runner: inlineRunner });
      const settle = () => vi.advanceTimersByTimeAsync(500);
      const flow = new PublishFlow(source, session, () => {}, () => {});
      await settle(); // brief / gist
      const first = flow.review!;
      flow.cycleTarget(); // r2
      for (const mode of [0, 2, 3]) {
        flow.setMode(mode);
        await settle();
      }
      flow.setMode(1);
      await settle(); // five reviews now: brief / gist is gone from the source
      flow.cycleTarget(); // back to gist
      await settle();
      expect(flow.target).toBe("gist");
      flow.next(); // continue
      flow.next(); // y: the review it holds is no longer in the source
      await settle();
      expect(flow.step).toBe("error");
      expect(p.gist.payloads).toEqual([]);
      flow.next(); // back to the mode step: the stale review is dropped and made again
      await settle();
      expect(flow.step).toBe("mode");
      expect(flow.review).toBeDefined();
      expect(flow.review!.id).not.toBe(first.id);
      flow.next();
      flow.next();
      await settle();
      expect(flow.step).toBe("done");
      expect(p.gist.payloads).toHaveLength(1);
      expect(Buffer.byteLength(p.gist.payloads[0]!.content)).toBe(flow.review!.bytes);
      flow.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
