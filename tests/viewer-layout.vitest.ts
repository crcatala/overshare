// @vitest-environment jsdom
/** Text layout helpers the viewer renders with: responsive text tables and edit diffs. */
import { describe, expect, it } from "vitest";
import { asciiTable, columnWidths, layoutTable, lineWidth, linesToText, releaseTables, tableModel, toGlyphs, wrapCell, type TableModel, type TableStyle } from "../viewer/src/asciitable.ts";
import { lineDiff, preview, trimContext } from "../viewer/src/text.ts";

(globalThis as { __OVERSHARE_SOURCES__?: Record<string, string> }).__OVERSHARE_SOURCES__ = {};
const { markdown } = await import("../viewer/src/dom.ts");
const { plainLine } = await import("../viewer/src/transcript.ts");

function model(head: string[], body: string[][]): TableModel {
  return { head: head.map((c) => toGlyphs(c)), body: body.map((r) => r.map((c) => toGlyphs(c))), align: head.map(() => "left"), styles: [{}] };
}

const text = (m: TableModel, cols: number, style: TableStyle = "rounded") => linesToText(layoutTable(m, cols, style));

const CURRENCIES = model(
  ["Code", "Name", "Minor unit exponent", "Notes"],
  [
    ["USD", "US dollar", "2", "default fallback when neither request nor customer sets one"],
    ["JPY", "Japanese yen", "0", "rounds half-up; the dashboard showed these 100× too large"],
  ],
);

describe("text tables", () => {
  it("draws a table at its natural width when it fits", () => {
    expect(text(model(["a", "bb"], [["1", "2"]]), 80)).toBe(["╭───┬────╮", "│ a │ bb │", "├───┼────┤", "│ 1 │ 2  │", "╰───┴────╯"].join("\n"));
  });

  it.each(["rounded", "square", "ascii", "minimal"] as TableStyle[])("never exceeds the available width (%s)", (style) => {
    for (const cols of [100, 80, 64, 50, 40, 30, 20]) {
      for (const line of layoutTable(CURRENCIES, cols, style)) expect(lineWidth(line)).toBeLessThanOrEqual(cols);
    }
  });

  it("keeps every row of a boxed table the same width, so the borders line up", () => {
    const lines = layoutTable(CURRENCIES, 64, "square");
    expect(new Set(lines.map(lineWidth)).size).toBe(1);
  });

  it("gives spare width to columns with long body text before wrapping them", () => {
    const widths = columnWidths(CURRENCIES, 80, "rounded")!;
    // The long header ("Minor unit exponent") wraps; the Notes column gets the room.
    expect(widths[2]).toBeLessThan("Minor unit exponent".length);
    expect(widths[3]).toBeGreaterThan(widths[2]!);
    // Whole words are kept.
    const out = text(CURRENCIES, 80);
    expect(out).toContain("Japanese");
    expect(out).toContain("exponent");
  });

  it("stacks rows as records when columns can't keep whole words", () => {
    const out = text(CURRENCIES, 36);
    expect(out).not.toContain("┬");
    expect(out).toMatch(/^Code\s+USD$/m);
    expect(out).toMatch(/^Name\s+US dollar$/m);
  });

  it("breaks long words in narrow two-column tables instead of stacking", () => {
    const url = model(["name", "url"], [["docs", "https://docs.example.com/a/very/long/path/that/does/not/fit"]]);
    const out = text(url, 30);
    expect(out).toContain("┬");
    for (const line of out.split("\n")) expect(line.length).toBeLessThanOrEqual(30);
  });

  it("counts emoji and CJK as two columns", () => {
    const lines = layoutTable(model(["s", "x"], [["🔴 High", "ok"], ["漢字", "ok"]]), 80, "rounded");
    expect(new Set(lines.map(lineWidth)).size).toBe(1);
    expect(linesToText(lines)).toContain("│ 🔴 High │");
  });

  it("wraps on words and breaks words longer than a line", () => {
    const lines = wrapCell(toGlyphs("alpha beta supercalifragilistic"), 8).map((l) => l.map((g) => g.c).join(""));
    expect(lines).toEqual(["alpha", "beta", "supercal", "ifragili", "stic"]);
  });

  it("keeps the labels of a header-only table, even when stacked", () => {
    const headOnly = model(["Severity", "Finding", "Where", "Owner", "Status"], []);
    expect(text(headOnly, 80)).toContain("│ Severity │ Finding │");
    const stacked = text(headOnly, 20);
    for (const label of ["Severity", "Finding", "Where", "Owner", "Status"]) expect(stacked).toContain(label);
  });

  it("keeps a nested raw-HTML table inside its cell instead of adding its rows", () => {
    const t = document.createElement("table");
    t.innerHTML = "<tr><td>a</td><td>b</td></tr><tr><td>c</td><td><table><tr><td>inner1</td></tr><tr><td>inner2</td></tr></table></td></tr>";
    const m = tableModel(t);
    // Whitespace as the layout draws it (runs collapse to one space).
    const cells = (r: typeof m.head) => r.map((c) => c.map((g) => g.c).join("").replace(/\s+/g, " ").trim());
    expect(cells(m.head)).toEqual(["a", "b"]);
    expect(m.body.map(cells)).toEqual([["c", "inner1 inner2"]]);
  });

  it("reads alignment, inline formatting and links from the rendered table", () => {
    const md = markdown("| Name | Count |\n| :--- | ---: |\n| **bold** `code` [link](https://example.com) | 7 |");
    const table = md.querySelector("table")!;
    const m = tableModel(table);
    expect(m.align).toEqual(["left", "right"]);
    const styles = new Set(m.body[0]![0]!.map((g) => JSON.stringify(m.styles[g.s])));
    expect(styles).toContain(JSON.stringify({ strong: true }));
    expect(styles).toContain(JSON.stringify({ code: true }));
    expect(styles).toContain(JSON.stringify({ href: "https://example.com" }));
  });
});

describe("markdown tables", () => {
  it("become a text grid and keep the real table for screen readers", () => {
    const md = markdown("| a | b |\n| - | - |\n| 1 | 2 |");
    const grid = md.querySelector(".atable .at-grid");
    expect(grid?.getAttribute("aria-hidden")).toBe("true");
    expect(grid?.textContent).toContain("│ a │ b │");
    expect(md.querySelector(".atable table.sr-only")).not.toBeNull();
  });

  it("do not let cell content carry classes or unsafe links", () => {
    const md = markdown('| a |\n| - |\n| <span class="prompt">x</span> [y](javascript:alert(1)) |');
    // Our own grid classes only; nothing from the share.
    for (const el of md.querySelectorAll("[class]")) {
      for (const c of el.classList) expect(c).toMatch(/^(md|atable|at-[\w-]+|sr-only)$/);
    }
    for (const a of md.querySelectorAll("a")) expect(a.getAttribute("href") ?? "").not.toMatch(/javascript:/i);
  });

  it("give each link one tab stop: the grid's copy is focusable, the hidden table's isn't", () => {
    const md = markdown("| site |\n| - |\n| [docs](https://example.com) |");
    const gridLink = md.querySelector(".at-grid a");
    const tableLink = md.querySelector("table a");
    expect(gridLink?.getAttribute("href")).toBe("https://example.com");
    expect(gridLink?.hasAttribute("tabindex")).toBe(false);
    expect(tableLink?.getAttribute("tabindex")).toBe("-1");
  });

  it("label code blocks with their language", () => {
    const md = markdown("```ts\nconst x = 1;\n```");
    expect(md.querySelector(".codeblock .codeblock-lang")?.textContent).toBe("ts");
    expect(md.querySelector(".codeblock pre code")?.className).toBe("language-ts");
  });
});

describe("table resize observing", () => {
  it("stops watching a render's tables when the viewer re-renders", () => {
    const observers: { targets: Element[]; disconnected: boolean }[] = [];
    const saved = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class {
      state = { targets: [] as Element[], disconnected: false };
      constructor() {
        observers.push(this.state);
      }
      observe(el: Element) {
        this.state.targets.push(el);
      }
      unobserve() {}
      disconnect() {
        this.state.disconnected = true;
      }
    } as unknown as typeof ResizeObserver;
    try {
      const table = () => {
        const t = document.createElement("table");
        t.innerHTML = "<thead><tr><th>a</th></tr></thead><tbody><tr><td>1</td></tr></tbody>";
        return t;
      };
      asciiTable(table());
      asciiTable(table());
      expect(observers).toHaveLength(1); // one observer per render…
      releaseTables();
      expect(observers[0]!.disconnected).toBe(true); // …released before the next one
      asciiTable(table());
      expect(observers).toHaveLength(2);
      expect(observers[1]!.targets).toHaveLength(1);
    } finally {
      releaseTables();
      globalThis.ResizeObserver = saved;
    }
  });
});

describe("edit diffs", () => {
  it("marks changed lines and keeps unchanged ones as context", () => {
    expect(lineDiff("a\nb\nc", "a\nB\nc")).toEqual([
      { op: " ", text: "a" },
      { op: "-", text: "b" },
      { op: "+", text: "B" },
      { op: " ", text: "c" },
    ]);
  });

  it("handles pure insertions and deletions", () => {
    expect(lineDiff("", "x\ny").map((d) => d.op)).toEqual(["+", "+"]);
    expect(lineDiff("x\ny", "").map((d) => d.op)).toEqual(["-", "-"]);
    expect(lineDiff("a\nc", "a\nb\nc").map((d) => d.op)).toEqual([" ", "+", " "]);
  });

  it("collapses long unchanged runs", () => {
    const before = Array.from({ length: 20 }, (_, i) => `l${i}`).join("\n");
    const after = before.replace("l10", "L10");
    const trimmed = trimContext(lineDiff(before, after), 1);
    expect(trimmed.map((d) => d.op)).toEqual(["…", " ", "-", "+", " ", "…"]);
    expect(trimmed[0]).toEqual({ op: "…", skipped: 9 });
  });

  it("previews the first lines and counts the rest", () => {
    expect(preview("1\n2\n3\n4\n5\n6", 3)).toEqual({ lines: ["1", "2", "3"], more: 3 });
    // Not worth a "+1 line" note.
    expect(preview("1\n2\n3\n4", 3)).toEqual({ lines: ["1", "2", "3", "4"], more: 0 });
  });
});

describe("outline labels", () => {
  it.each([
    ["## Review of `src/invoices`\n\n| a |", "Review of src/invoices"],
    ["Found it: `DATABASE_URL` points at **5433**", "Found it: DATABASE_URL points at 5433"],
    ["Opened [acme/api#166](https://github.com/acme/api/pull/166) from `fix/x`.", "Opened acme/api#166 from fix/x."],
    ["```ts\nconst x = 1;\n```\nThen *this* ran", "const x = 1;"],
    ["- item one\n- item two", "item one"],
  ])("%j → %j", (md, label) => {
    expect(plainLine(md)).toBe(label);
  });
});
