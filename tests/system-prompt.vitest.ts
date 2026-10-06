import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.js";
import { parseClaudeCode } from "../src/harnesses/claude-code/parse.js";
import { projectSession } from "../src/modes.js";
import { prepareShare } from "../src/pipeline.js";
import { formatReport } from "../src/report.js";
import { ClaudeTranscript, ccUsage, fake } from "./helpers.js";

const machine = { homeDir: "/home/tester", username: "tester", hostname: "box" };

function transcript(secret = "no secret here"): string {
  return new ClaudeTranscript("aaaaaaaa-0000-0000-0000-000000000000", "/home/tester/work/demo")
    .attachment({ type: "prompt_snapshot", systemPrompt: ["You are an old prompt.", "__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__"] })
    .attachment({ type: "instructions", files: [{ path: "/home/tester/.claude/CLAUDE.md", type: "User", content: "my private CLAUDE.md" }] })
    .user("hello")
    .assistant("m1", [{ type: "text", text: "hi" }], ccUsage(1, 1))
    .attachment({
      type: "prompt_snapshot",
      systemPrompt: ["\nYou are an interactive agent.\n", "__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__", "", `Memory lives at /home/tester/.claude/projects/-home-tester-work-demo/memory/ (${secret})`],
    })
    .user("again")
    .assistant("m2", [{ type: "text", text: "ok" }], ccUsage(1, 1))
    .toJsonl();
}

describe("system prompt (opt-in)", () => {
  it("keeps the last snapshot on the branch, without the boundary marker, and not CLAUDE.md", () => {
    const { session, dropped } = parseClaudeCode(transcript());
    expect(session.systemPrompt).toEqual(["You are an interactive agent.", "Memory lives at /home/tester/.claude/projects/-home-tester-work-demo/memory/ (no secret here)"]);
    expect(dropped["attachment:prompt_snapshot"]).toBeUndefined();
    expect(dropped["attachment:instructions"]).toBe(1);
    expect(JSON.stringify(session)).not.toContain("my private CLAUDE.md");
  });

  describe("branch selection", () => {
    const snap = (text: string) => ({ type: "prompt_snapshot", systemPrompt: [text] });
    const turn = (t: ClaudeTranscript, prompt: string, id: string, snapshot?: string) =>
      (snapshot ? t.attachment(snap(snapshot)) : t).user(prompt).assistant(id, [{ type: "text", text: `reply to ${prompt}` }], ccUsage(1, 1));

    it("takes the kept branch's snapshot after a rewind", () => {
      const t = turn(new ClaudeTranscript(), "p1", "m1", "KEPT");
      const fork = t.lastUuid!;
      turn(t, "old p2", "m2", "DISCARDED");
      turn(t.rewindTo(fork), "new p2", "m3");
      expect(parseClaudeCode(t.toJsonl()).session.systemPrompt).toEqual(["KEPT"]);
    });

    it("takes the kept branch's snapshot when a long discarded branch makes the parser fall back to file order", () => {
      const t = turn(new ClaudeTranscript(), "p1", "m1", "KEPT");
      const fork = t.lastUuid!;
      for (let i = 0; i < 4; i++) turn(t, `old p${i}`, `mo${i}`, `DISCARDED-${i}`);
      turn(t.rewindTo(fork), "new p2", "m9");
      const { session } = parseClaudeCode(t.toJsonl());
      expect(session.systemPrompt).toEqual(["KEPT"]);
      expect(JSON.stringify(session)).not.toContain("DISCARDED");
    });

    it("never takes a snapshot written after an explicit leaf", () => {
      const t = turn(new ClaudeTranscript(), "p1", "m1", "EARLY");
      const leaf = t.lastUuid!;
      turn(t, "p2", "m2", "AFTER-LEAF");
      expect(parseClaudeCode(t.toJsonl(), { leafId: leaf }).session.systemPrompt).toEqual(["EARLY"]);
    });

    it("has none when the only snapshot is off the branch, or the leaf is unknown", () => {
      const t = turn(new ClaudeTranscript(), "p1", "m1");
      const fork = t.lastUuid!;
      turn(t, "old p2", "m2", "DISCARDED");
      turn(t.rewindTo(fork), "new p2", "m3");
      expect(parseClaudeCode(t.toJsonl()).session.systemPrompt).toBeUndefined();
      expect(parseClaudeCode(transcript(), { leafId: "no-such-entry" }).session.systemPrompt).toBeUndefined();
    });
  });

  it("is dropped by default, and in every mode but full", () => {
    for (const [mode, includeSystemPrompt] of [["full", false], ["full", undefined], ["brief", true], ["minimal", true], ["prompts", true]] as const) {
      const { json, session, report } = prepareShare(transcript(), { mode, config: DEFAULT_CONFIG, machine, knownSecrets: [], includeSystemPrompt });
      expect(session.systemPrompt).toBeUndefined();
      expect(json).not.toContain("interactive agent");
      expect(report.dropped["system-prompt"]).toBe(1);
      expect(report.systemPrompt).toBeUndefined();
    }
  });

  it("is shared on request in full mode, redacted like the rest", () => {
    const secret = fake.github();
    const { json, session, report } = prepareShare(transcript(secret), { mode: "full", config: DEFAULT_CONFIG, machine, knownSecrets: [], includeSystemPrompt: true });
    expect(session.systemPrompt).toHaveLength(2);
    expect(session.systemPrompt![1]).toContain("~/.claude/projects/");
    expect(json).not.toContain("/home/tester");
    expect(json).not.toContain(secret);
    expect(json).not.toContain("my private CLAUDE.md");
    expect(report.counts["secret-pattern"]).toBe(1);
    expect(report.findings.some((f) => f.where === "system prompt")).toBe(true);
    expect(report.dropped["system-prompt"]).toBeUndefined();
    expect(report.systemPrompt).toEqual({ sections: 2, chars: session.systemPrompt!.reduce((n, p) => n + p.length, 0) });
    expect(formatReport(report)).toContain("Included on request:\n  system prompt (2 sections");
  });

  it("is dropped when a full share steps down to another mode", () => {
    const { session } = prepareShare(transcript(), { mode: "full", config: DEFAULT_CONFIG, machine, knownSecrets: [], includeSystemPrompt: true });
    expect(projectSession(session, "full").systemPrompt).toBeDefined();
    expect(projectSession(session, "brief").systemPrompt).toBeUndefined();
  });
});
