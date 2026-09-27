import { describe, expect, it } from "vitest";
import { parseClaudeCode } from "../src/adapters/claude-code.js";
import { availableModes, projectSession } from "../src/modes.js";
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
  it("full keeps tool detail but truncates long results", () => {
    const full = projectSession(session(), "full", { maxToolChars: 10 });
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

  it("can step down from brief to minimal but never up", () => {
    const brief = projectSession(session(), "brief");
    const minimal = projectSession(brief, "minimal");
    expect(minimal.turns[0]!.steps[0]).toMatchObject({ kind: "toolGroup", total: 4 });
    expect(() => projectSession(minimal, "full")).toThrow();
    expect(availableModes("brief")).toEqual(["brief", "minimal"]);
  });
});
