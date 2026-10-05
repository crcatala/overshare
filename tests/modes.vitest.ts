import { describe, expect, it } from "vitest";
import { parseClaudeCode } from "../src/harnesses/claude-code/parse.js";
import { availableModes, capToolText, projectSession } from "../src/modes.js";
import { ClaudeTranscript, ccUsage } from "./helpers.js";

function session() {
  const t = new ClaudeTranscript()
    .user("refactor the loader")
    .assistant(
      "m1",
      [
        { type: "thinking", thinking: "consider options", signature: "s" },
        { type: "tool_use", id: "r1", name: "Read", input: { file_path: "src/a.ts" } },
        { type: "tool_use", id: "r2", name: "Read", input: { file_path: "src/b.ts" } },
      ],
      ccUsage(10, 5, 100, 0, 3),
    )
    .toolResult("r1", "A".repeat(50))
    .toolResult("r2", "B")
    .assistant(
      "m2",
      [
        { type: "tool_use", id: "e1", name: "Edit", input: { file_path: "src/a.ts", old_string: "x", new_string: "y" } },
        { type: "tool_use", id: "b1", name: "Bash", input: { command: "npm test\n# more" } },
      ],
      ccUsage(10, 5, 200),
    )
    .toolResult("e1", "ok")
    .toolResult("b1", "1 failing", {}, true)
    .assistant("m3", [{ type: "text", text: "Tests fail; investigating." }], ccUsage(1, 1))
    .assistant("m4", [{ type: "tool_use", id: "a1", name: "Agent", input: { subagent_type: "Explore", description: "look" } }], ccUsage(1, 1))
    .toolResult("a1", "subagent output with details")
    .assistant("m5", [{ type: "text", text: "Fixed." }], ccUsage(1, 1));
  return parseClaudeCode(t.toJsonl()).session;
}

describe("share modes", () => {
  it("full keeps tool detail whole; capToolText truncates long results (on redacted text, see title-secret-prefix and tool-text-secret-prefix)", () => {
    expect(JSON.stringify(projectSession(session(), "full"))).toContain("A".repeat(50));
    const full = capToolText(projectSession(session(), "full"), 10);
    const read = full.turns[0]!.steps.find((s) => s.kind === "tool" && s.name === "Read" && s.id === "r1");
    expect(read).toMatchObject({ result: { truncatedFrom: 50 } });
    expect(read?.kind === "tool" && read.result?.text.startsWith("AAAAAAAAAA\n… [truncated 40 chars]")).toBe(true);
  });

  it("brief groups work into tool groups and strips tool output", () => {
    const brief = projectSession(session(), "brief");
    const steps = brief.turns[0]!.steps;
    expect(steps.map((s) => s.kind)).toEqual(["toolGroup", "text", "subagent", "text"]);
    expect(steps[0]).toMatchObject({
      kind: "toolGroup",
      total: 4,
      calls: [
        { name: "Read", count: 2, errors: 0 },
        { name: "Edit", count: 1, errors: 0 },
        { name: "Bash", count: 1, errors: 1 },
      ],
      files: { read: ["src/a.ts", "src/b.ts"], edited: ["src/a.ts"], written: [] },
      commands: ["npm test"],
      responseIds: ["m1", "m2"],
      thinking: { blocks: 1, chars: 16, tokens: 3 },
    });
    const json = JSON.stringify(brief);
    expect(json).not.toContain("AAAAAAAAAA");
    expect(json).not.toContain("subagent output with details");
    expect(json).not.toContain("consider options");
  });

  it("minimal keeps the prompt, last reply and a counts-only group", () => {
    const minimal = projectSession(session(), "minimal");
    const steps = minimal.turns[0]!.steps;
    expect(steps.map((s) => s.kind)).toEqual(["toolGroup", "subagent", "text"]);
    expect(steps.at(-1)).toMatchObject({ text: "Fixed." });
    expect(steps[0]).toMatchObject({ total: 4, commands: [] });
    expect(JSON.stringify(minimal)).not.toContain("investigating");
  });

  it("prompts strips every work string, retaining only prompts, metadata and numeric activity", () => {
    const full = session();
    full.turns[0]!.user!.expanded = "expanded skill instructions";
    full.turns[0]!.steps.push({ kind: "event", id: "evt", event: "compaction", text: "event prose", detail: "compaction secrets" });
    const prompts = projectSession(full, "prompts");
    expect(prompts.turns[0]).toMatchObject({
      user: { text: "refactor the loader" }, steps: [],
      activity: { toolCalls: 5, toolErrors: 1, files: { read: 2, edited: 1, written: 0 } },
    });
    expect(prompts.turns[0]!.user!.expanded).toBeUndefined();
    expect(prompts.responses).toEqual(full.responses);
    expect(prompts.stats).toEqual(full.stats);
    const json = JSON.stringify(prompts);
    for (const text of ["src/a.ts", "src/b.ts", "npm test", "consider options", "Fixed.", "investigating", "subagent output", "Explore", "expanded skill", "event prose", "compaction secrets", "AAAAAAAAAA"]) expect(json).not.toContain(text);
    expect(projectSession(prompts, "prompts")).toEqual(prompts);
    expect(availableModes("prompts")).toEqual(["prompts"]);
    for (const mode of ["full", "brief", "minimal"] as const) expect(() => projectSession(prompts, mode)).toThrow();
  });

  it("derives the same numeric activity directly, and through richer projections", () => {
    const full = session();
    const direct = projectSession(full, "prompts");
    for (const mode of ["full", "brief", "minimal"] as const) {
      const projected = projectSession(full, mode);
      expect(projectSession(projected, "prompts")).toEqual(direct);
    }
  });

  it("counts calls separately from unique files, by action and by turn", () => {
    const full = session();
    full.turns[0]!.steps.push(
      { kind: "tool", id: "again", name: "Read", action: "read", summary: "src/a.ts", files: ["src/a.ts"] },
      { kind: "tool", id: "write", name: "Write", action: "write", summary: "src/a.ts", files: ["src/a.ts"], result: { text: "failed", isError: true } },
    );
    full.turns.push({ index: 1, user: { text: "next" }, steps: [{ kind: "tool", id: "next", name: "Read", action: "read", summary: "src/a.ts", files: ["src/a.ts"] }] });
    const prompts = projectSession(full, "prompts");
    expect(prompts.turns.map((t) => t.activity)).toEqual([
      { toolCalls: 7, toolErrors: 2, files: { read: 2, edited: 1, written: 1 } },
      { toolCalls: 1, toolErrors: 0, files: { read: 1, edited: 0, written: 0 } },
    ]);
  });

  it("can step down from brief to minimal but never up", () => {
    const brief = projectSession(session(), "brief");
    const minimal = projectSession(brief, "minimal");
    expect(minimal.turns[0]!.steps[0]).toMatchObject({ kind: "toolGroup", total: 4 });
    expect(() => projectSession(minimal, "full")).toThrow();
    expect(availableModes("brief")).toEqual(["brief", "minimal", "prompts"]);
  });
});
