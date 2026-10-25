/**
 * The archive's markdown: prompts show what was typed, model headings sit below the role headings, and nothing a
 * transcript contains can open a fence or a heading that swallows the rest of the file. Checked by parsing the output
 * with `marked` (the viewer's markdown parser), not by comparing strings alone.
 */
import fc from "fast-check";
import { JSDOM } from "jsdom";
import { marked, type Token } from "marked";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.js";
import { closeOpenFence, frontmatter, promptMarkdown, relevelHeadings, renderMarkdown } from "../src/markdown.js";
import { prepareShare } from "../src/pipeline.js";
import type { ShareMode } from "../src/schema.js";
import { ClaudeTranscript, ccUsage } from "./helpers.js";

const machine = { homeDir: "/home/tester", username: "tester", hostname: "box" };

/** Every token in the tree, depth first. */
function tokens(md: string): Token[] {
  const out: Token[] = [];
  const walk = (list: Token[] | undefined) => {
    for (const t of list ?? []) {
      out.push(t);
      const any = t as Token & { tokens?: Token[]; items?: Token[] };
      walk(any.tokens);
      walk(any.items);
    }
  };
  walk(marked.lexer(md));
  return out;
}

const types = (md: string) => new Set(tokens(md).map((t) => t.type));

const { document } = new JSDOM("").window;

/** The text a reader sees, one entry per visible line. */
function visibleLines(md: string): string[] {
  document.body.innerHTML = (marked.parse(md, { async: false }) as string).replace(/<br>/g, "\n");
  const text = document.body.textContent ?? "";
  return text.split("\n").map((l) => l.trim().replace(/\s+/g, " ")).filter(Boolean);
}

describe("promptMarkdown", () => {
  it("shows the example prompt as typed: hard breaks, an indented log fenced, nothing eaten", () => {
    const prompt = [
      "the r2 retry test fails ~1 in 5 runs. output:",
      "AssertionError: expected 2 calls, got 3",
      "    at tests/r2.test.ts:88:12",
      "    at processTicksAndRejections (node:internal/process/task_queues:95:5)",
      "# this started after the backoff change",
      "don't touch <RetryPolicy> or *any* of the max_attempts config",
    ].join("\n");
    const md = promptMarkdown(prompt);
    expect(md).toBe(
      [
        // A lone `~` is escaped: in one paragraph it could pair with a `~` on a later line (strikethrough).
        "the r2 retry test fails \\~1 in 5 runs. output:\\",
        "AssertionError: expected 2 calls, got 3",
        "",
        "```text",
        "    at tests/r2.test.ts:88:12",
        "    at processTicksAndRejections (node:internal/process/task_queues:95:5)",
        "```",
        "",
        "\\# this started after the backoff change\\",
        "don't touch \\<RetryPolicy> or *any* of the max_attempts config",
      ].join("\n"),
    );
    const seen = types(md);
    expect(seen.has("heading")).toBe(false);
    expect(seen.has("html")).toBe(false);
    expect(seen.has("em")).toBe(true); // *any* was meant
    expect(visibleLines(md)).toContain("# this started after the backoff change");
    expect(visibleLines(md)).toContain("don't touch <RetryPolicy> or any of the max_attempts config");
  });

  it("keeps lists, links, inline code, tables and fenced blocks", () => {
    const md = promptMarkdown(["steps:", "- one `<x>`", "- two [docs](https://example.com)", "", "| a | b |", "|---|---|", "| 1 | 2 |", "after", "```ts", "const a = 1 # x", "```"].join("\n"));
    const seen = types(md);
    for (const t of ["list", "codespan", "link", "table", "code"]) expect(seen.has(t), t).toBe(true);
    // The line after a table is not one more row.
    expect(md).toContain("| 1 | 2 |\n\nafter");
    expect(tokens(md).find((t) => t.type === "code")?.text).toBe("const a = 1 # x");
  });

  it("escapes what would become markup: quotes, rules, setext underlines, link definitions, entities, stray emphasis", () => {
    const md = promptMarkdown(["> not a quote", "title", "---", "===", "[1]: not a definition", "&copy; stays", "2*3 and src/*.ts", "snake_case_name", "* * *"].join("\n"));
    const seen = types(md);
    for (const t of ["blockquote", "heading", "hr", "def", "em", "strong", "list"]) expect(seen.has(t), t).toBe(false);
    expect(visibleLines(md)).toEqual(["> not a quote", "title", "---", "===", "[1]: not a definition", "&copy; stays", "2*3 and src/*.ts", "snake_case_name", "* * *"]);
    // `_` inside a word is not emphasis in CommonMark, so it is left as typed.
    expect(md).toContain("snake_case_name");
  });

  it("closes a fence the prompt left open, and a stray backtick cannot start a span across lines", () => {
    const md = promptMarkdown("look:\n```\nunterminated");
    expect(md.endsWith("\n```")).toBe(true);
    const stray = promptMarkdown("a ` here\nand ` there");
    expect(types(stray).has("codespan")).toBe(false);
    expect(visibleLines(stray)).toEqual(["a ` here", "and ` there"]);
  });

  it("never yields block markup the prompt did not contain, and keeps every line's text (property)", () => {
    const piece = fc.constantFrom("word", "x", " ", "  ", "#", "##", ">", "=", "==", "-", "*", "_", "<", "<a>", "&", "&amp;", "|", "1.", "~", ":", "[x]", "(y)", "\\");
    const line = fc.array(piece, { maxLength: 8 }).map((p) => p.join(""));
    fc.assert(
      fc.property(fc.array(line, { minLength: 1, maxLength: 6 }), (lines) => {
        const prompt = lines.join("\n");
        const md = promptMarkdown(prompt);
        const seen = types(md);
        for (const t of ["heading", "html", "blockquote", "hr", "def"]) expect(seen.has(t), `${t} in ${JSON.stringify(md)}`).toBe(false);
      }),
      { numRuns: 400 },
    );
  });

  it("shows plain lines exactly as typed (property)", () => {
    const piece = fc.constantFrom("word", "x", " ", "#", "##", ">", "=", "<", "<b>", "&", "&amp;", "~", ":", "\\", "!", "(", ")", "*", "_");
    const line = fc.array(piece, { minLength: 1, maxLength: 8 }).map((p) => p.join(""));
    // Paired `*`, `_` and `~~` are kept as emphasis and strikethrough on purpose, so their markers are not compared;
    // nor is the width of a run of spaces.
    const norm = (s: string) => s.replace(/[*_~]/g, "").trim().replace(/\s+/g, " ");
    fc.assert(
      fc.property(fc.array(line, { minLength: 1, maxLength: 5 }), (lines) => {
        const expected = lines.map(norm).filter(Boolean);
        // A line ending in a backslash is covered by the escaping test above; a fence (`~~~`) is kept as one on purpose.
        fc.pre(lines.every((l) => !/\\\s*$/.test(l) && !/^ {0,3}~~~/.test(l)));
        expect(visibleLines(promptMarkdown(lines.join("\n"))).map(norm).filter(Boolean)).toEqual(expected);
      }),
      { numRuns: 400 },
    );
  });
});

describe("relevelHeadings", () => {
  it("moves the shallowest heading to the top level and keeps the rest relative", () => {
    expect(relevelHeadings("## a\ntext\n### b", 3)).toBe("### a\ntext\n#### b");
    expect(relevelHeadings("# a\n## b", 3)).toBe("### a\n#### b");
    // Pulled up too: a message whose only headings are H5 starts at H3.
    expect(relevelHeadings("##### deep", 3)).toBe("### deep");
  });

  it("turns a heading that would pass H6 into bold text (H5 and H6 when H1 is used)", () => {
    expect(relevelHeadings("# a\n## b\n### c\n#### d\n##### e\n###### f", 3)).toBe("### a\n#### b\n##### c\n###### d\n**e**\n**f**");
    const parsed = tokens(relevelHeadings("# a\n###### f", 3));
    expect(parsed.filter((t) => t.type === "heading").map((t) => (t as Token & { depth: number }).depth)).toEqual([3]);
    expect(parsed.some((t) => t.type === "strong")).toBe(true);
  });

  it("converts setext headings, and leaves code fences and closing hashes alone", () => {
    expect(relevelHeadings("Title\n=====\nSub\n---\ntext", 3)).toBe("### Title\n#### Sub\ntext");
    expect(relevelHeadings("## a ##\n```\n# not a heading\n```\n````md\n```\n# still code\n```\n````", 3)).toBe("### a\n```\n# not a heading\n```\n````md\n```\n# still code\n```\n````");
    // A rule after a blank line is not a heading.
    expect(relevelHeadings("# a\n\n---\n", 3)).toBe("### a\n\n---\n");
  });

  it("closes a fence a message left open", () => {
    expect(closeOpenFence("text\n~~~~\ncode")).toBe("text\n~~~~\ncode\n~~~~");
    expect(closeOpenFence("```\nok\n```")).toBe("```\nok\n```");
  });
});

describe("frontmatter", () => {
  it("writes strings as JSON strings, so a title with `: \"` or a newline stays one value", () => {
    const fm = frontmatter({ title: 'a: "b"\n---\nc', n: 3, ok: true, list: ["x", "y"], nested: { a: 1, gone: undefined }, empty: { gone: undefined }, missing: undefined });
    expect(fm).toBe(['---', 'title: "a: \\"b\\"\\n---\\nc"', "n: 3", "ok: true", 'list: ["x", "y"]', "nested:", "  a: 1", "---"].join("\n"));
    for (const line of fm.split("\n").slice(1, -1)) {
      const value = /^\s*[a-z_]+:(?: (.*))?$/.exec(line)?.[1];
      if (value !== undefined) expect(() => JSON.parse(value)).not.toThrow();
    }
  });
});

describe("renderMarkdown", () => {
  const session = (mode: ShareMode) => {
    const t = new ClaudeTranscript("aaaaaaaa-0000-0000-0000-000000000000", "/home/tester/work/demo")
      .user("fix *the* bug in <Widget>")
      .assistant("m1", [{ type: "text", text: "Looking.\n```ts\nopen fence" }], ccUsage(1, 1))
      .assistant("m2", [{ type: "tool_use", id: "b1", name: "Bash", input: { command: "npm test" } }], ccUsage(1, 1))
      .toolResult("b1", "ok")
      .assistant("m3", [{ type: "text", text: "## Result\nFixed.\n###### Detail\nfine" }], ccUsage(1, 1))
      .user("<command-name>/review</command-name><command-args>src/a.ts</command-args>")
      .assistant("m4", [{ type: "text", text: "Looks good." }], ccUsage(1, 1));
    return prepareShare(t.toJsonl(), { mode, config: DEFAULT_CONFIG, harness: "claude-code", machine, knownSecrets: [] }).session;
  };

  it("minimal: one title, User/Assistant H2s with the turn number, the final message only, no tool lines", () => {
    const md = renderMarkdown(session("minimal"));
    const headings = tokens(md).filter((t) => t.type === "heading").map((t) => `${"#".repeat((t as Token & { depth: number }).depth)} ${(t as Token & { text: string }).text}`);
    expect(headings).toEqual(["# fix \\*the\\* bug in \\<Widget\\>", "## User (Turn 1)", "## Assistant (Turn 1)", "### Result", "## User (Turn 2) · `/review`", "## Assistant (Turn 2)"]);
    expect(md).not.toContain("Looking.");
    expect(md).not.toContain("Tools:");
    expect(md).toContain("**Detail**");
    expect(md).toContain("fix *the* bug in \\<Widget>");
  });

  it("brief: every message of a turn under one Assistant heading; an open fence ends with its message", () => {
    const md = renderMarkdown(session("brief"));
    expect(md.match(/## Assistant \(Turn 1\)/g)).toHaveLength(1);
    expect(md).toContain("Looking.\n```ts\nopen fence\n```\n\n### Result");
    expect(md).not.toContain("npm test");
  });

  it("--tools adds a tool-group line (and brief's commands); full mode lists each call", () => {
    expect(renderMarkdown(session("minimal"), { tools: true })).toContain("_Tools: Bash ×1_");
    expect(renderMarkdown(session("brief"), { tools: true })).toContain("_Tools: Bash ×1_\n- `npm test`");
    expect(renderMarkdown(session("full"), { tools: true })).toContain("- **Bash** `npm test`");
    expect(renderMarkdown(session("full"))).not.toContain("npm test");
  });
});
