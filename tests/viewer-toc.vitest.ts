// @vitest-environment jsdom
/** The contents rail's filter: which rows stay, and what gets highlighted. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TurnInfo } from "../viewer/src/transcript.ts";

(globalThis as { __AGENT_SHARE_SOURCES__?: Record<string, string> }).__AGENT_SHARE_SOURCES__ = {};
const { renderToc } = await import("../viewer/src/toc.ts");

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
  toc = renderToc(turns, () => {});
  document.body.append(toc.el);
});
afterEach(() => {
  document.body.replaceChildren();
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
    const evil = renderToc([turn(0, "<img src=x onerror=alert(1)> payload")], () => {});
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
