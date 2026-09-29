// @vitest-environment jsdom
/** The contents rail's filter: which rows stay, and what gets highlighted. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TurnInfo } from "../viewer/src/transcript.ts";

(globalThis as { __AGENT_SHARE_SOURCES__?: Record<string, string> }).__AGENT_SHARE_SOURCES__ = {};
const { renderToc } = await import("../viewer/src/toc.ts");

/** The detail setting lives with the viewer's settings; a rail under test keeps it in a variable. */
const opts = (onClear = () => {}) => ({ detail: "prompts" as const, onDetail: () => {}, onClear });

const turn = (index: number, label: string, items: TurnInfo["items"] = []): TurnInfo => ({
  index,
  ordinal: index + 1,
  id: `t${index}`,
  el: document.createElement("div"),
  label,
  tools: 0,
  errors: 0,
  items,
  calls: [],
  responses: [],
});

const turns = [
  turn(0, "Fix the pre-commit hook", [
    { id: "a", kind: "reply", label: "The hook runs prettier twice" },
    { id: "b", kind: "tools", label: "Bash(git) ×3 · Edit" },
  ]),
  turn(1, "Add a search box", [{ id: "c", kind: "reply", label: "Done: the search box filters rows" }]),
  turn(2, "Deploy to staging"),
];

let toc: ReturnType<typeof renderToc>;
let jumps: { id: string; hit?: { ids: string[]; tokens: string[] } }[];
let cleared: number;
const search = () => toc.el.querySelector<HTMLInputElement>(".toc-search")!;
const rows = () => [...toc.el.querySelectorAll<HTMLElement>(".toc-turn")];
const visible = () => rows().filter((r) => !r.hidden).map((r) => r.querySelector(".toc-label")!.textContent);
const hits = (root: ParentNode = toc.el) => [...root.querySelectorAll(".toc-hit")].map((m) => m.textContent);

/** Type a query and let the frame that applies it run. */
async function type(value: string) {
  search().value = value;
  search().dispatchEvent(new Event("input"));
  await new Promise((r) => requestAnimationFrame(() => r(undefined)));
}

beforeEach(() => {
  jumps = [];
  cleared = 0;
  toc = renderToc(
    turns,
    (id, hit) => jumps.push({ id, hit }),
    opts(() => cleared++),
  );
  document.body.append(toc.el);
});
afterEach(() => {
  document.body.replaceChildren();
});

describe("clicking a result", () => {
  const link = (row: number, item?: number) => (item === undefined ? rows()[row]!.querySelector<HTMLElement>(":scope > .toc-link")! : rows()[row]!.querySelectorAll<HTMLElement>(".toc-item .toc-link")[item]!);

  it("hands over the words when the clicked label matched", async () => {
    await type("Search Box");
    link(1).click();
    expect(jumps).toEqual([{ id: "t1", hit: { ids: ["t1"], tokens: ["search", "box"] } }]);
  });

  it("hands over an item's own id", async () => {
    await type("prettier");
    link(0, 0).click();
    expect(jumps).toEqual([{ id: "a", hit: { ids: ["a"], tokens: ["prettier"] } }]);
  });

  it("hands over every step of a tool run", async () => {
    const run = renderToc([turn(0, "Run tools", [{ id: "r1", ids: ["r1", "r2", "r3"], kind: "tools", label: "Bash(git) ×3" }])], (id, hit) => jumps.push({ id, hit }), opts());
    document.body.append(run.el);
    const box = run.el.querySelector<HTMLInputElement>(".toc-search")!;
    box.value = "git";
    box.dispatchEvent(new Event("input"));
    await new Promise((r) => requestAnimationFrame(() => r(undefined)));
    run.el.querySelector<HTMLElement>(".toc-item .toc-link")!.click();
    expect(jumps[0]).toEqual({ id: "r1", hit: { ids: ["r1", "r2", "r3"], tokens: ["git"] } });
  });

  it("hands over nothing for a row that only matched through its items", async () => {
    await type("prettier");
    link(0).click();
    expect(jumps).toEqual([{ id: "t0", hit: undefined }]);
  });

  it("hands over nothing without a filter", () => {
    link(2).click();
    expect(jumps).toEqual([{ id: "t2", hit: undefined }]);
  });

  it("leaves the outlines alone when an edit keeps the same words", async () => {
    await type("search box");
    expect(cleared).toBe(1);
    await type("search box ");
    await type("Search  box");
    await type("search-box");
    expect(cleared).toBe(1);
    await type("search boxes");
    expect(cleared).toBe(2);
  });

  it("tells the viewer when the filter changes or is cleared", async () => {
    await type("sea");
    await type("search");
    expect(cleared).toBe(2);
    search().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(cleared).toBe(3);
  });
});

describe("rail filter", () => {
  it("shows every prompt and no highlights without a query", () => {
    expect(visible()).toHaveLength(3);
    expect(hits()).toEqual([]);
  });

  it("treats a hyphen in the query as a space, and the other way round", async () => {
    await type("pre commit");
    expect(visible()).toEqual(["Fix the pre-commit hook"]);
    await type("pre-commit");
    expect(visible()).toEqual(["Fix the pre-commit hook"]);
  });

  it("requires every word, in any order", async () => {
    await type("hook fix");
    expect(visible()).toEqual(["Fix the pre-commit hook"]);
    await type("hook staging");
    expect(visible()).toEqual([]);
    expect(toc.el.querySelector<HTMLElement>(".toc-empty")!.hidden).toBe(false);
  });

  it("highlights the words in the prompt label, keeping its text intact", async () => {
    await type("pre commit");
    const label = rows()[0]!.querySelector(".toc-label")!;
    expect(hits(label)).toEqual(["pre", "commit"]);
    expect(label.textContent).toBe("Fix the pre-commit hook");
  });

  it("keeps a highlighted label's pieces inside one child, so a space between two hits survives layout", async () => {
    await type("search box");
    const label = rows()[1]!.querySelector(".toc-label")!;
    expect(hits(label)).toEqual(["search", "box"]);
    expect(label.childNodes).toHaveLength(1);
    expect(label.firstElementChild!.tagName).toBe("SPAN");
    expect(label.textContent).toBe("Add a search box");
  });

  it("keeps a turn when only one of its items matches, and shows just that item", async () => {
    await type("prettier");
    expect(visible()).toEqual(["Fix the pre-commit hook"]);
    const items = [...rows()[0]!.querySelectorAll<HTMLElement>(".toc-item")];
    expect(items.map((i) => i.hidden)).toEqual([false, true]);
    expect(hits(items[0]!)).toEqual(["prettier"]);
    expect(hits(rows()[0]!.querySelector(".toc-link")!.querySelector(".toc-label")!)).toEqual([]);
  });

  it("matches each label on its own, not the prompt and its items together", async () => {
    // "staging" is in one prompt and "prettier" in another turn's item: no row has both.
    await type("prettier staging");
    expect(visible()).toEqual([]);
    // "fix" is only in the prompt, "prettier" only in the item: no single label has both.
    await type("fix prettier");
    expect(visible()).toEqual([]);
  });

  it("filters on a single character but only highlights words of two or more", async () => {
    await type("x");
    expect(visible().length).toBeGreaterThan(0);
    expect(hits()).toEqual([]);
  });

  it("finds tool-run labels", async () => {
    await type("git edit");
    const item = rows()[0]!.querySelectorAll<HTMLElement>(".toc-item")[1]!;
    expect(item.hidden).toBe(false);
    expect(hits(item)).toEqual(["git", "Edit"]);
  });

  it("drops the highlights and restores the rows when the query is cleared", async () => {
    await type("search");
    expect(hits().length).toBeGreaterThan(0);
    await type("");
    expect(hits()).toEqual([]);
    expect(visible()).toHaveLength(3);
    expect([...toc.el.querySelectorAll<HTMLElement>(".toc-item")].every((i) => i.hidden)).toBe(true);
  });

  it("clears on Escape without waiting for a frame", async () => {
    await type("search");
    search().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(search().value).toBe("");
    expect(hits()).toEqual([]);
    expect(visible()).toHaveLength(3);
  });

  it("ignores a query made only of punctuation", async () => {
    await type(" - . ");
    expect(visible()).toHaveLength(3);
    expect(hits()).toEqual([]);
  });

  it("renders labels as text, never as markup", async () => {
    const evil = renderToc([turn(0, "<img src=x onerror=alert(1)> payload")], () => {}, opts());
    document.body.append(evil.el);
    const box = evil.el.querySelector<HTMLInputElement>(".toc-search")!;
    box.value = "payload";
    box.dispatchEvent(new Event("input"));
    await new Promise((r) => requestAnimationFrame(() => r(undefined)));
    expect(evil.el.querySelector("img")).toBeNull();
    expect(evil.el.querySelector(".toc-label")!.textContent).toBe("<img src=x onerror=alert(1)> payload");
    expect([...evil.el.querySelectorAll(".toc-hit")].map((m) => m.textContent)).toEqual(["payload"]);
  });
});
