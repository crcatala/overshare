import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseSession } from "../src/adapters/index.js";
import { createSource, viewFromSession } from "../src/browse/source.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { PromptsUnavailableError } from "../src/modes.js";
import { publishPrepared } from "../src/publish/index.js";
import type { Publisher, PublishPayload } from "../src/publish/types.js";
import { buildIndex } from "../src/sessions/index.js";
import { loadShares, sharesFor } from "../src/sessions/shares.js";
import { ccUsage, ClaudeTranscript, fake, PiTranscript } from "./helpers.js";

let dir: string;
const saved = { ...process.env };
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "browse-src-"));
  process.env.AGENT_SHARE_SHARES = join(dir, "state", "shares.json");
});
afterEach(() => {
  process.env = { ...saved };
});

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
  it("reviews with the real pipeline: secrets are found, redacted, and never in the summary", () => {
    const secret = fake.github();
    const { sessions, session } = indexed(secret);
    const source = createSource({ config: DEFAULT_CONFIG, sessions });
    const review = source.review(session, "full");
    expect(review.clean).toBe(false);
    expect(review.findings.length).toBeGreaterThan(0);
    expect(JSON.stringify(review)).not.toContain(secret);
    expect(source.review(indexed().session, "full").clean).toBe(true);
  });

  it("publishes exactly the payload that was reviewed, even if the session file changes afterwards", async () => {
    const { file, sessions, session } = indexed();
    const publisher = recordingPublisher();
    const source = createSource({ config: DEFAULT_CONFIG, sessions, publisher: () => publisher });
    source.review(session, "brief");
    // The session keeps growing (or is edited) after the user looked at the review.
    writeFileSync(file, `${readFileSync(file, "utf8")}${JSON.stringify({ type: "user", uuid: "late", parentUuid: null, sessionId: "sess-1", timestamp: "2026-01-02T00:00:00Z", message: { role: "user", content: "a late prompt nobody reviewed" } })}\n`);
    await source.publish(session, "brief");
    expect(publisher.payloads).toHaveLength(1);
    expect(publisher.payloads[0]!.content).not.toContain("a late prompt nobody reviewed");
    // A second publish re-scans from disk, so it does include the new content.
    await source.publish(session, "brief");
    expect(publisher.payloads[1]!.content).toContain("a late prompt nobody reviewed");
  });

  it("uploads the redacted payload, never the raw secret", async () => {
    const secret = fake.github();
    const { sessions, session } = indexed(secret);
    const publisher = recordingPublisher();
    const source = createSource({ config: DEFAULT_CONFIG, sessions, publisher: () => publisher });
    await source.publish(session, "full");
    expect(publisher.payloads[0]!.content).not.toContain(secret);
    expect(publisher.payloads[0]!.description).toContain("agent-share:");
  });

  it("records the share in shares.json and in memory so the list marks it immediately", async () => {
    const { sessions, session } = indexed();
    const source = createSource({ config: DEFAULT_CONFIG, sessions, publisher: () => recordingPublisher() });
    expect(sharesFor(source.shares, "claude-code", "sess-1")).toHaveLength(0);
    const out = await source.publish(session, "brief");
    expect(out.url).toBe("https://viewer.example/#abc123");
    expect(sharesFor(source.shares, "claude-code", "sess-1").map((r) => r.url)).toEqual(["https://viewer.example/#abc123"]);
    const onDisk = loadShares();
    expect(onDisk["claude-code:sess-1"]).toHaveLength(1);
    expect(onDisk["claude-code:sess-1"]![0]).toMatchObject({ mode: "brief", target: "gist" });
  });

  it("does not hide an upload that succeeded when shares.json cannot be written", async () => {
    const { sessions, session } = indexed();
    writeFileSync(join(dir, "blocker"), "a file, not a directory");
    process.env.AGENT_SHARE_SHARES = join(dir, "blocker", "shares.json");
    const source = createSource({ config: DEFAULT_CONFIG, sessions, publisher: () => recordingPublisher() });
    const out = await source.publish(session, "brief");
    expect(out.url).toBe("https://viewer.example/#abc123");
    expect(out.warnings.join(" ")).toContain("could not record this share");
    expect(sharesFor(source.shares, "claude-code", "sess-1")).toHaveLength(1); // still marked in this run
  });

  it("refuses prompts mode for a legacy pi session instead of guessing", () => {
    const pi = join(dir, "pi", "--home-me-work-app--");
    mkdirSync(pi, { recursive: true });
    const t = new PiTranscript("01a0aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee", "/home/me/work/app").user("a prompt with no recorded authored input");
    writeFileSync(join(pi, "2026-01-01T00-00-00-000Z_01a0aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee.jsonl"), t.toJsonl());
    const sessions = buildIndex({ roots: { "claude-code": join(dir, "none"), pi: join(dir, "pi") }, cachePath: join(dir, "index.json") });
    const source = createSource({ config: DEFAULT_CONFIG, sessions });
    expect(() => source.review(sessions[0]!, "prompts")).toThrow(PromptsUnavailableError);
    expect(source.review(sessions[0]!, "brief").mode).toBe("brief"); // other modes are unaffected
  });

  it("reports unusable publish targets before anything is scanned or sent", () => {
    const { sessions } = indexed();
    delete process.env.AGENT_SHARE_R2_ACCESS_KEY_ID;
    delete process.env.AGENT_SHARE_R2_SECRET_ACCESS_KEY;
    const r2 = createSource({ config: { ...DEFAULT_CONFIG, target: "r2" }, sessions });
    expect(r2.preflight().error).toMatch(/r2/i);
    expect(r2.destination).toContain("R2");
    const gist = createSource({ config: DEFAULT_CONFIG, sessions });
    expect(gist.preflight().error).toBeUndefined();
    expect(gist.destination).toContain("gist");
  });

  it("view reads the local transcript", () => {
    const { sessions, session } = indexed();
    const view = createSource({ config: DEFAULT_CONFIG, sessions }).view(session);
    expect(view.items[0]).toMatchObject({ kind: "user", label: "deploy the app" });
    expect(view.tools).toEqual({ Bash: 1 });
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
    expect(publisher.payloads[0]!.filename).toBe("session.json");
    expect(loadShares()["claude-code:sess-1"]![0]).toMatchObject({ url: "https://viewer.example/#abc123", mode: "minimal" });
  });
});
