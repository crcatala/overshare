// @vitest-environment jsdom
/** Full-text search: what the index holds per view, how entries match, and the snippets. */
import { describe, expect, it } from "vitest";
import { SCHEMA_VERSION, type NormalizedSession, type Step, type Turn } from "../src/schema.ts";

(globalThis as { __AGENT_SHARE_SOURCES__?: Record<string, string> }).__AGENT_SHARE_SOURCES__ = {};
const { buildIndex, outputOnlyTurns, search, snippet } = await import("../viewer/src/search.ts");
const { queryTokens } = await import("../viewer/src/filter.ts");
const { projectSession } = await import("../src/modes.ts");

function session(turns: Turn[]): NormalizedSession {
  return {
    schema: SCHEMA_VERSION,
    mode: "full",
    harness: { name: "pi" },
    source: { sessionId: "test" },
    project: { cwd: "/home/tester/app", name: "app" },
    models: [],
    stats: {
      turns: turns.length,
      userPrompts: turns.length,
      responses: 0,
      toolCalls: 0,
      tools: {},
      toolErrors: 0,
      thinking: { blocks: 0, chars: 0, tokens: 0 },
      subagents: 0,
      compactions: 0,
      files: { read: 0, edited: 0, written: 0 },
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
      peakContext: 0,
    },
    responses: [],
    turns,
  };
}

const steps: Step[] = [
  { kind: "thinking", id: "k", text: "The ledger rounding looks off by a cent", chars: 40, blocks: 1 },
  {
    kind: "tool",
    id: "b",
    name: "Bash",
    action: "exec",
    summary: "npm run migrate -- --env staging",
    input: { command: "npm run migrate -- --env staging" },
    result: { text: "Applied 3 migrations\nECONNREFUSED on retry" },
  },
  {
    kind: "tool",
    id: "e",
    name: "Edit",
    action: "edit",
    summary: "/home/tester/app/src/invoices/create.ts",
    files: ["/home/tester/app/src/invoices/create.ts"],
    input: { file_path: "/home/tester/app/src/invoices/create.ts", old_string: "const total = 0", new_string: "const total = parseInvoice(raw)" },
    result: { text: "Edit applied" },
  },
  { kind: "text", id: "r", text: "Done. The **invoice** total now comes from `parseInvoice`." },
  { kind: "subagent", id: "a", tool: "Task", agents: ["reviewer"], description: "Review the rounding fix", result: { text: "Looks good, no regressions" } },
];
const s = session([
  { index: 0, user: { text: "Fix invoice rounding before the release" }, steps },
  { index: 1, user: { text: "Ship it" }, steps: [{ kind: "text", id: "z", text: "Shipped to staging" }] },
]);

const find = (query: string, output = false, from = s) => search(buildIndex(from), queryTokens(query), output).map((h) => `${h.doc.id} ${h.field.source}`);

describe("buildIndex", () => {
  it("has one entry per prompt and step, with the transcript's ids", () => {
    expect(buildIndex(s).map((d) => d.id)).toEqual(["turn-0-prompt", "s-0-0", "s-0-1", "s-0-2", "s-0-3", "s-0-4", "turn-1-prompt", "s-1-0"]);
  });

  it("shows paths relative to the project, as the transcript does", () => {
    const edit = buildIndex(s).find((d) => d.id === "s-0-2")!;
    expect(edit.fields[0]!.text.split("\n")[0]).toBe("src/invoices/create.ts");
  });

  it("holds only what the view keeps", () => {
    const brief = projectSession(s, "brief");
    // Brief folds the thinking and tool calls into one group, keeping commands and file names
    // but not tool output, thinking text or subagent results.
    expect(find("migrate staging", true, brief)).toEqual(["s-0-0 commands"]);
    expect(find("ECONNREFUSED", true, brief)).toEqual([]);
    expect(find("ledger", true, brief)).toEqual([]);
    expect(find("invoices create", true, brief)).toEqual(["s-0-0 files"]);
    const minimal = projectSession(s, "minimal");
    expect(find("migrate", true, minimal)).toEqual([]);
  });
});

describe("search", () => {
  it("finds words that no rail label shows: reply bodies, thinking, commands, paths and edits", () => {
    expect(find("comes from")).toEqual(["s-0-3 reply"]);
    expect(find("ledger")).toEqual(["s-0-0 thinking"]);
    expect(find("env staging")).toEqual(["s-0-1 Bash"]);
    expect(find("invoices/create.ts")).toEqual(["s-0-2 Edit"]);
    expect(find("parseInvoice")).toEqual(["s-0-2 Edit", "s-0-3 reply"]);
  });

  it("looks in tool and subagent output only when asked", () => {
    expect(find("econnrefused")).toEqual([]);
    expect(find("econnrefused", true)).toEqual(["s-0-1 Bash output"]);
    expect(find("regressions", true)).toEqual(["s-0-4 Task output"]);
  });

  it("requires every word in one entry, not spread over a turn", () => {
    // "release" is in the prompt, "ledger" in the thinking: same turn, different entries.
    expect(find("release ledger")).toEqual([]);
    expect(find("rounding release")).toEqual(["turn-0-prompt prompt"]);
  });

  it("lets a word in the input and one in the output of the same call match together", () => {
    // The snippet comes from the field with the most words: here a tie, so the first.
    expect(find("migrate econnrefused", true)).toEqual(["s-0-1 Bash"]);
    expect(find("migrate econnrefused")).toEqual([]);
  });

  it("uses the label filter's rules: case, punctuation and order don't matter", () => {
    expect(find("STAGING, env")).toEqual(["s-0-1 Bash"]);
    expect(find("to-staging SHIPPED")).toEqual(["s-1-0 reply"]);
  });

  it("counts the turns that only tool output would add", () => {
    const docs = buildIndex(s);
    expect(outputOnlyTurns(docs, ["econnrefused"], new Set())).toBe(1);
    expect(outputOnlyTurns(docs, ["econnrefused"], new Set([0]))).toBe(0);
  });
});

describe("snippet", () => {
  it("cuts around the first hit at word boundaries and marks the hits", () => {
    const text = `${"lorem ipsum ".repeat(30)}the needle is here ${"dolor sit ".repeat(30)}`;
    const snip = snippet(text, ["needle"], 60);
    expect(snip.text.startsWith("…")).toBe(true);
    expect(snip.text.endsWith("…")).toBe(true);
    expect(snip.text).toContain("the needle is here");
    expect(snip.text.split(" ").every((w) => /^…?(lorem|ipsum|the|needle|is|here|dolor|sit)…?$/.test(w))).toBe(true);
    const [start, end] = snip.ranges[0]!;
    expect(snip.text.slice(start, end)).toBe("needle");
  });

  it("stays on the hit's line, keeping a short one whole", () => {
    expect(snippet("fix the\n  pre-commit   hook\nlater", ["hook"])).toEqual({ text: "pre-commit hook", ranges: [[11, 15]] });
  });

  it("drops markdown syntax from markdown fields, table cells included", () => {
    const table = "| Severity | Finding |\n| --- | --- |\n| High | `toMinorUnits` assumes **2** decimals |";
    expect(snippet(table, ["tominorunits"], 120, true).text).toBe("High · toMinorUnits assumes 2 decimals");
    expect(snippet(table, ["tominorunits"]).text).toBe("| High | `toMinorUnits` assumes **2** decimals |");
  });

  it("falls back to the raw line when only the syntax held the word", () => {
    expect(snippet("See [the docs](https://example.com/zero-decimal)", ["decimal"], 120, true).text).toContain("zero-decimal");
  });

  it("takes the line holding the most of the words", () => {
    expect(snippet("two decimals here\nzero-decimal currencies", ["zero", "decimal"]).text).toBe("zero-decimal currencies");
  });

  it("shows the first line when no word is long enough to find", () => {
    expect(snippet("\nfirst line\nsecond", ["x"]).text).toBe("first line");
  });

  it("does not treat the words as a pattern", () => {
    expect(() => snippet("a (b) c", ["b"])).not.toThrow();
  });
});
