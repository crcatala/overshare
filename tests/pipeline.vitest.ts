import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.js";
import { prepareShare } from "../src/pipeline.js";
import { ClaudeTranscript, ccUsage, fake } from "./helpers.js";

const machine = { homeDir: "/home/tester", username: "tester", hostname: "box" };

function transcriptWithSecretInToolOutput(secret: string): string {
  return new ClaudeTranscript("aaaaaaaa-0000-0000-0000-000000000000", "/home/tester/work/demo")
    .user("check the env for /home/tester/work/demo")
    .assistant("m1", [{ type: "tool_use", id: "b1", name: "Bash", input: { command: "env | sort" } }], ccUsage(10, 5))
    .toolResult("b1", `PATH=/usr/bin\nSERVICE_TOKEN=${secret}\nHOME=/home/tester`)
    .assistant("m2", [{ type: "text", text: "The env looks fine." }], ccUsage(10, 5))
    .toJsonl();
}

describe("prepareShare", () => {
  it("reports secrets only for content the chosen mode publishes", () => {
    const secret = fake.github();
    const raw = transcriptWithSecretInToolOutput(secret);
    const full = prepareShare(raw, { mode: "full", config: DEFAULT_CONFIG, machine, knownSecrets: [] });
    expect(full.report.clean).toBe(false);
    expect(full.report.counts["secret-pattern"]).toBe(1);
    expect(full.json).not.toContain(secret);

    const brief = prepareShare(raw, { mode: "brief", config: DEFAULT_CONFIG, machine, knownSecrets: [] });
    expect(brief.report.clean).toBe(true);
    expect(brief.json).not.toContain(secret);
    expect(brief.json).not.toContain("SERVICE_TOKEN");
  });

  it("strips prompts-mode work before redaction but still redacts the authored prompt", () => {
    const hidden = fake.envValue();
    const visible = fake.envValue();
    const raw = new ClaudeTranscript()
      .user(`Please check ${visible}`)
      .assistant("m1", [
        { type: "thinking", thinking: `reasoning ${hidden}`, signature: "sig" },
        { type: "tool_use", id: "r", name: "Read", input: { file_path: `src/${hidden}.ts` } },
      ], ccUsage(10, 5, 0, 0, 2))
      .toolResult("r", `output ${hidden}`)
      .assistant("m2", [{ type: "text", text: `final reply ${hidden}` }], ccUsage(10, 5))
      .toJsonl();
    const { session, json, report } = prepareShare(raw, {
      mode: "prompts", config: DEFAULT_CONFIG, machine,
      knownSecrets: [{ value: hidden, label: "HIDDEN", source: "env" }, { value: visible, label: "VISIBLE", source: "env" }],
    });
    expect(json).not.toContain(hidden);
    expect(json).not.toContain(visible);
    expect(report.findings.every((f) => !f.where.includes("Read") && !f.where.includes("thinking") && !f.where.includes("text"))).toBe(true);
    expect(report.findings.some((f) => f.where.includes("prompt"))).toBe(true);
    expect(session.turns[0]).toMatchObject({ steps: [], activity: { toolCalls: 1, files: { read: 1, edited: 0, written: 0 } } });
    expect(session.stats).toMatchObject({ toolCalls: 1, thinking: { tokens: 2 } });
    expect(report.blocked).toBe(false);
    expect(report.clean).toBe(false); // Retained user content still needs review.
  });

  it("never leaves the home directory in the payload and fills metadata", () => {
    const { session, json, report } = prepareShare(transcriptWithSecretInToolOutput("x"), {
      mode: "brief",
      config: DEFAULT_CONFIG,
      machine,
      knownSecrets: [],
      now: new Date("2026-02-02T00:00:00Z"),
    });
    expect(json).not.toContain("/home/tester");
    expect(session).toMatchObject({
      schema: "agentshare/1",
      mode: "brief",
      title: "check the env for ~/work/demo",
      project: { cwd: "~/work/demo", name: "demo" },
      generator: { name: "agent-share", sharedAt: "2026-02-02T00:00:00.000Z" },
      stats: { turns: 1, toolCalls: 1, tools: { Bash: 1 } },
    });
    expect(session.durationMs).toBeGreaterThan(0);
    expect(report.counts["home-path"]).toBeGreaterThan(0);
    expect(report.blocked).toBe(false);
  });

  it("blocks publishing when the re-scan finds a secret that redaction skipped", () => {
    // Session ids are metadata and skip content redaction; a known secret there must still be caught.
    const secret = fake.envValue();
    const raw = new ClaudeTranscript(secret).user("hi").toJsonl();
    const { report } = prepareShare(raw, {
      mode: "brief",
      config: DEFAULT_CONFIG,
      machine,
      knownSecrets: [{ value: secret, label: "LEAKED", source: "env" }],
    });
    expect(report.blocked).toBe(true);
    expect(report.clean).toBe(false);
    expect(report.rescan[0]).toMatchObject({ rule: "known-secret:LEAKED" });
  });
});
