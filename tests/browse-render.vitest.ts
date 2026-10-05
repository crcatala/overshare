import { describe, expect, it } from "vitest";
import { parseSession } from "../src/harnesses/index.js";
import { highlight } from "../src/browse/highlight.js";
import { viewFromSession } from "../src/browse/job.js";
import { plainText } from "../src/browse/kit.js";
import { diffLines, markdown, renderItem } from "../src/browse/render.js";
import type { ViewItem } from "../src/browse/source.js";
import { ccUsage, ClaudeTranscript, PiTranscript } from "./helpers.js";

/** Plain text, right edge trimmed (a tinted diff line is padded to the pane's width). */
const plain = (lines: string[]) => lines.map((l) => plainText(l).trimEnd());
const item = (over: Partial<ViewItem> & Pick<ViewItem, "kind" | "body">): ViewItem => ({ turn: 1, label: "x", ...over });
const CONTROLS = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/;

describe("highlight", () => {
  const SAMPLES: Array<[string, string]> = [
    ["bash", "npm test -- --run && git commit -m \"it's ok\" # done\nfor f in *.ts; do echo $f ${HOME}; done\nFOO=1 node x.js | grep 'a b' > out.txt"],
    ["json", '{\n  "name": "x",\n  "n": -1.5e3,\n  "ok": true,\n  "list": [null, "a\\"b"]\n}'],
    ["ts", "/* block\ncomment */ const x: Map<string, number> = new Map(); // tail\nconst s = `a${b}`;\nexport async function f(a = 'x') { return 42 }"],
    ["py", "# comment\ndef f(x):\n    return x + 1  # tail\nclass A: pass"],
    ["diff", "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n same"],
    ["sql", "select * from t -- why\nwhere a = 'x'"],
    ["weird", "'unterminated \"quote\n\u001b not really\n`tick"],
  ];

  it("never changes the text, only colours it, whatever the language or input", () => {
    for (const [lang, code] of SAMPLES) expect(plainText(highlight(code, lang).join("\n")), lang).toBe(code);
  });

  it("returns an unknown language unchanged", () => {
    expect(highlight("a b\nc", "klingon")).toEqual(["a b", "c"]);
    expect(highlight("a b", undefined)).toEqual(["a b"]);
  });

  it("colours shell: the program bold, flags, strings, variables and comments each their own", () => {
    const [l] = highlight("npm run build --silent \"$HOME\" # note", "bash");
    expect(l).toMatch(/\x1b\[1m[^\n]*npm/); // the command is bold
    expect(l).toContain("\x1b[38;5;180m--silent"); // flag
    expect(l).toContain("\x1b[38;5;114m\"$HOME\""); // string
    expect(l).toContain("\x1b[38;5;244m# note"); // comment
  });

  it("does not treat # inside a word or a string as a comment", () => {
    const [l] = highlight("echo a#b '# not'", "sh");
    expect(l).not.toContain("\x1b[38;5;244m");
  });

  it("tells JSON keys from string values", () => {
    const [l] = highlight('{"k": "v"}', "json");
    expect(l).toContain("\x1b[38;5;110m\"k\"");
    expect(l).toContain("\x1b[38;5;114m\"v\"");
  });

  it("keeps a block comment going across lines", () => {
    const lines = highlight("/* one\ntwo */ let x", "ts");
    expect(lines[0]).toContain("\x1b[38;5;244m/* one");
    expect(lines[1]).toContain("\x1b[38;5;244mtwo */");
    expect(lines[1]).toContain("\x1b[38;5;176mlet");
  });
});

describe("markdown", () => {
  it("renders an assistant message: no raw markers, wrapped to the width", () => {
    const lines = plain(markdown("# Title\n\nSome **bold** and `code` in a sentence that is long enough to wrap around.\n\n- one\n- two\n\n```bash\nnpm test\n```", 30));
    const text = lines.join("\n");
    expect(text).toContain("Title");
    expect(text).not.toMatch(/\*\*|`code`|^# /m);
    expect(text).toMatch(/- one/);
    expect(lines.every((l) => l.length <= 30)).toBe(true);
  });

  it("highlights fenced code through the highlighter", () => {
    const raw = markdown("```bash\nnpm test\n```", 40).join("\n");
    expect(raw).toContain("\x1b[1m\x1b[38;5;75mnpm"); // bold command colour
  });

  it("draws tables", () => {
    expect(plain(markdown("| a | b |\n|---|---|\n| 1 | 2 |", 40)).join("\n")).toContain("│ 1 │ 2 │");
  });
});

describe("renderItem", () => {
  it("draws an assistant message as markdown", () => {
    expect(plain(renderItem(item({ kind: "assistant", body: "Use **this**." }), 40)).join("\n")).toBe("Use this.");
  });

  it("leaves a prompt as typed: its * and _ are not markdown", () => {
    expect(plain(renderItem(item({ kind: "user", body: "fix *args and _kwargs_ in `f`\n\n- a" }), 60))).toEqual(["fix *args and _kwargs_ in `f`", "", "- a"]);
  });

  it("falls back to the wrapped plain body when an item has no blocks", () => {
    expect(plain(renderItem(item({ kind: "tool", body: "src/a.ts\n\n── result ──\nok" }), 40))).toEqual(["src/a.ts", "", "── result ──", "ok"]);
  });

  it("draws an edit as a diff with counts, keeping the unchanged lines as context", () => {
    const lines = plain(
      renderItem(item({ kind: "tool", body: "x", blocks: [{ type: "edit", path: "src/a.ts", edits: [{ old: "const a = 1;\nconst b = 2;\nreturn a;", new: "const a = 1;\nconst b = 3;\nconst c = 4;\nreturn a;" }] }] }), 50),
    );
    expect(lines[0]).toBe("src/a.ts  +2 −1");
    expect(lines.slice(1)).toEqual(["  const a = 1;", "- const b = 2;", "+ const b = 3;", "+ const c = 4;", "  return a;"]);
  });

  it("tints removed and added lines across the full width", () => {
    const raw = renderItem(item({ kind: "tool", body: "x", blocks: [{ type: "edit", edits: [{ old: "a", new: "b" }] }] }), 30);
    expect(raw[1]).toMatch(/^\x1b\[48;5;52m/);
    expect(raw[2]).toMatch(/^\x1b\[48;5;22m/);
    expect(plainText(raw[1]!)).toHaveLength(30);
  });

  it("collapses a long unchanged stretch", () => {
    const body = Array.from({ length: 30 }, (_, i) => `line ${i}`);
    const lines = plain(renderItem(item({ kind: "tool", body: "x", blocks: [{ type: "edit", edits: [{ old: body.join("\n"), new: body.map((l) => (l === "line 15" ? "changed" : l)).join("\n") }] }] }), 50));
    expect(lines.length).toBeLessThan(14);
    expect(lines.some((l) => /⋯ \d+ unchanged lines/.test(l))).toBe(true);
    expect(lines).toContain("- line 15");
    expect(lines).toContain("+ changed");
  });

  it("wraps a long path in an edit header and in a file label, so the file name and the counts survive", () => {
    const path = "/home/someone/workspace/some-long-project-name/packages/frontend/src/components/billing/InvoiceCurrencyPicker.tsx";
    const edit = plain(renderItem(item({ kind: "tool", body: "x", blocks: [{ type: "edit", path, edits: [{ old: "a", new: "b" }] }] }), 40));
    const header = edit.slice(0, edit.findIndex((l) => l.startsWith("-")));
    expect(header.join("").replace(/\s/g, "")).toBe(`${path}+1−1`);
    const label = plain(renderItem(item({ kind: "tool", body: "x", blocks: [{ type: "label", text: path }, { type: "label", text: path, style: "error" }] }), 40));
    expect(label.join("").replace(/[\s✗]/g, "")).toBe(path + path);
    for (const l of [...edit, ...label]) expect(l.length).toBeLessThanOrEqual(40);
  });

  it("separates blocks with a blank line, but not a label from what it labels", () => {
    const lines = plain(renderItem(item({ kind: "tool", body: "x", blocks: [{ type: "code", text: "ls", lang: "bash" }, { type: "label", text: "result" }, { type: "code", text: "a\nb" }] }), 40));
    expect(lines).toEqual(["▏ ls", "", "result", "▏ a", "▏ b"]);
  });

  it("wraps long code lines instead of cutting them", () => {
    const lines = plain(renderItem(item({ kind: "tool", body: "x", blocks: [{ type: "code", text: "x".repeat(50) }] }), 22));
    expect(lines.join("").replace(/[▏ ]/g, "")).toBe("x".repeat(50));
    expect(lines.length).toBeGreaterThan(2);
  });
});

describe("diffLines", () => {
  it("finds the common lines", () => {
    expect(diffLines("a\nb\nc", "a\nx\nc").map((o) => o.op + o.line)).toEqual([" a", "-b", "+x", " c"]);
  });
  it("copes with empty sides and with huge ones", () => {
    expect(diffLines("", "x").map((o) => o.op)).toEqual(["-", "+"]);
    const big = Array.from({ length: 800 }, (_, i) => `l${i}`).join("\n");
    expect(diffLines(big, big + "\nmore").length).toBe(800 + 801); // too big for the table: all removed, all added
  });
});

describe("the tool blocks viewFromSession makes", () => {
  const claude = (name: string, input: unknown, result = "ok") =>
    viewFromSession(
      parseSession(new ClaudeTranscript().user("go").assistant("m1", [{ type: "tool_use", id: "t1", name, input }], ccUsage(1, 1)).toolResult("t1", result).toJsonl(), "claude-code").session,
    ).items.find((i) => i.kind === "tool")!;
  const pi = (name: string, args: unknown, result = "ok") =>
    viewFromSession(parseSession(new PiTranscript().user("go").assistant([{ type: "toolCall", id: "c1", name, arguments: args }]).toolResult("c1", name, result).toJsonl(), "pi").session).items.find((i) => i.kind === "tool")!;

  it("Bash (either harness): the command as shell, with its description, then the result", () => {
    for (const t of [claude("Bash", { command: "npm test", description: "Run the tests" }, "12 passed"), pi("bash", { command: "npm test" }, "12 passed")]) {
      expect(t.blocks).toContainEqual({ type: "code", text: "npm test", lang: "bash" });
      expect(t.blocks).toContainEqual({ type: "code", text: "12 passed", lang: undefined, output: true });
    }
    expect(claude("Bash", { command: "ls", description: "List" }).blocks![0]).toEqual({ type: "text", text: "List", style: "dim" });
  });

  it("Edit / MultiEdit / pi edit: an edit block with the replacements", () => {
    expect(claude("Edit", { file_path: "/a.ts", old_string: "a", new_string: "b" }).blocks![0]).toEqual({ type: "edit", path: "/a.ts", edits: [{ old: "a", new: "b" }] });
    expect(claude("MultiEdit", { file_path: "/a.ts", edits: [{ old_string: "a", new_string: "b" }, { old_string: "c", new_string: "d" }] }).blocks![0]).toMatchObject({ type: "edit", edits: [{ old: "a", new: "b" }, { old: "c", new: "d" }] });
    expect(pi("edit", { path: "/a.ts", edits: [{ oldText: "a", newText: "b" }] }).blocks![0]).toEqual({ type: "edit", path: "/a.ts", edits: [{ old: "a", new: "b" }] });
    expect(pi("edit", { path: "/a.ts", oldText: "a", newText: "b" }).blocks![0]).toMatchObject({ type: "edit" });
  });

  it("shows the boilerplate result of an edit or a write as one dim line, and an error as an error", () => {
    expect(claude("Edit", { file_path: "/a.ts", old_string: "a", new_string: "b" }, "The file /a.ts has been updated.").blocks!.at(-1)).toEqual({ type: "text", text: "The file /a.ts has been updated.", style: "dim", output: true });
    const failed = viewFromSession(
      parseSession(new ClaudeTranscript().user("go").assistant("m1", [{ type: "tool_use", id: "t1", name: "Edit", input: { file_path: "/a.ts", old_string: "a", new_string: "b" } }], ccUsage(1, 1)).toolResult("t1", "String not found", {}, true).toJsonl(), "claude-code").session,
    ).items.find((i) => i.kind === "tool")!;
    expect(failed.blocks).toContainEqual({ type: "label", text: "error", style: "error", output: true });
  });

  it("Write: the file name, then the content as code in the file's language", () => {
    const t = claude("Write", { file_path: "/x/run.sh", content: "echo hi" });
    expect(t.blocks!.slice(0, 2)).toEqual([{ type: "label", text: "/x/run.sh" }, { type: "code", text: "echo hi", lang: "sh" }]);
  });

  it("Read: the path, then the result in the file's language", () => {
    const t = claude("Read", { file_path: "/x/a.ts", offset: 10, limit: 20 }, "const a = 1");
    expect(t.blocks).toEqual([{ type: "label", text: "/x/a.ts  (from line 10, 20 lines)" }, { type: "label", text: "result", output: true }, { type: "code", text: "const a = 1", lang: "ts", output: true }]);
  });

  it("any other tool: its summary and its input as JSON", () => {
    const t = claude("Grep", { pattern: "foo", path: "src" });
    expect(t.blocks).toContainEqual({ type: "code", text: JSON.stringify({ pattern: "foo", path: "src" }, null, 2), lang: "json" });
  });

  it("keeps the plain body, which is what y copies", () => {
    const t = claude("Bash", { command: "npm test" }, "12 passed");
    expect(t.body).toContain("npm test");
    expect(t.body).toContain("── result ──\n12 passed");
  });

  it("strips terminal control sequences from every block", () => {
    const evil = "\x1b]52;c;ZXZpbA==\x07\x1b[2J";
    const items = [
      claude("Bash", { command: `echo ${evil}`, description: `d ${evil}` }, `out ${evil}`),
      claude("Edit", { file_path: `/a${evil}.ts`, old_string: `a${evil}`, new_string: `b${evil}` }, `r ${evil}`),
      claude("Write", { file_path: `/a${evil}.ts`, content: `c${evil}` }),
      claude("Other", { k: evil }, `r ${evil}`),
    ];
    for (const it of items) {
      for (const b of it.blocks!) {
        const strings = b.type === "edit" ? [b.path ?? "", ...b.edits.flatMap((e) => [e.old, e.new])] : [b.text, ...(b.type === "code" ? [b.lang ?? ""] : [])];
        for (const s of strings) expect(s).not.toMatch(CONTROLS);
      }
    }
  });
});
