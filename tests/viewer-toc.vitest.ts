// @vitest-environment jsdom
/** The contents rail's filter: which rows stay, and what gets highlighted. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TurnInfo } from "../viewer/src/transcript.ts";

(globalThis as { __OVERSHARE_SOURCES__?: Record<string, string> }).__OVERSHARE_SOURCES__ = {};
const { renderToc } = await import("../viewer/src/toc.ts");
const { fold } = await import("../viewer/src/filter.ts");
type SearchDoc = import("../viewer/src/search.ts").SearchDoc;

/**
 * The detail setting lives with the viewer's settings; a rail under test keeps it in a variable.
 * "all" by default: it searches everything, which is what most of these tests are about.
 */
const opts = (onClear = () => {}, detail: "prompts" | "all" = "all") => ({ detail, onDetail: () => {}, onClear });

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
    // With detail "all", every item shows again.
    expect([...toc.el.querySelectorAll<HTMLElement>(".toc-item")].every((i) => !i.hidden)).toBe(true);
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

  it("shows only the stretch around the hit in a long label", async () => {
    const long = renderToc([turn(0, `/implement ${"spec text ".repeat(12)}the needle ${"more text ".repeat(12)}`)], () => {}, opts());
    document.body.append(long.el);
    const box = long.el.querySelector<HTMLInputElement>(".toc-search")!;
    box.value = "needle";
    box.dispatchEvent(new Event("input"));
    await new Promise((r) => requestAnimationFrame(() => r(undefined)));
    expect(long.el.querySelector(".toc-label")!.textContent).toBe("…spec text the needle more text more…");
  });

  it("renders labels as text, never as markup", async () => {
    const evil = renderToc([turn(0, "<img src=x onerror=alert(1)> payload")], () => {}, opts());
    document.body.append(evil.el);
    const box = evil.el.querySelector<HTMLInputElement>(".toc-search")!;
    box.value = "payload";
    box.dispatchEvent(new Event("input"));
    await new Promise((r) => requestAnimationFrame(() => r(undefined)));
    expect(evil.el.querySelector("img")).toBeNull();
    // A long label shows only the stretch around the hit, still as text.
    expect(evil.el.querySelector(".toc-label")!.textContent).toBe("…payload");
    expect(evil.el.querySelector(".toc-link")!.getAttribute("title")).toBe("<img src=x onerror=alert(1)> payload");
    expect([...evil.el.querySelectorAll(".toc-hit")].map((m) => m.textContent)).toEqual(["payload"]);
  });
});

describe("full-text search", () => {
  const doc = (turn: number, id: string, fields: { source: string; text: string; output?: boolean }[]): SearchDoc => {
    const folded = fields.map((f) => ({ ...f, folded: fold(f.text) }));
    return { turn, id, fields: folded, inputs: folded.filter((f) => !f.output).map((f) => f.folded).join(" "), all: folded.map((f) => f.folded).join(" ") };
  };
  const index: SearchDoc[] = [
    doc(0, "turn-0-prompt", [{ source: "prompt", text: "Fix the pre-commit hook" }]),
    doc(0, "a", [{ source: "reply", text: "The hook runs prettier twice, so the second run rewrites the lockfile" }]),
    doc(0, "b", [
      { source: "Bash", text: "git commit -m wip" },
      { source: "Bash output", text: "husky - pre-commit hook exited with code 1 ECONNREFUSED", output: true },
    ]),
    doc(1, "c", [{ source: "reply", text: "Done: the search box filters rows" }]),
    ...[1, 2, 3, 4, 5].map((n) => doc(2, `d${n}`, [{ source: "thinking", text: `step ${n} of the staging deploy` }])),
  ];
  let built: number;
  let rail: ReturnType<typeof renderToc>;
  const box = () => rail.el.querySelector<HTMLInputElement>(".toc-search")!;
  const snippets = (row?: number) => [...(row === undefined ? rail.el : rowsOf()[row]!).querySelectorAll<HTMLElement>(".toc-found:not([hidden]) .toc-k-found")].map((li) => li.textContent);
  const rowsOf = () => [...rail.el.querySelectorAll<HTMLElement>(".toc-turn")];
  const shownRows = () => rowsOf().filter((r) => !r.hidden).map((r) => r.querySelector(".toc-label")!.textContent);
  const scope = () => rail.el.querySelector<HTMLButtonElement>(".toc-output")!;
  async function find(value: string) {
    box().value = value;
    box().dispatchEvent(new Event("input"));
    await new Promise((r) => requestAnimationFrame(() => r(undefined)));
  }

  beforeEach(() => {
    built = 0;
    rail = renderToc(turns, (id, hit) => jumps.push({ id, hit }), {
      ...opts(() => cleared++),
      index: () => {
        built++;
        return index;
      },
    });
    document.body.append(rail.el);
  });

  it("builds the index once, on first use", async () => {
    expect(built).toBe(0);
    box().dispatchEvent(new Event("focus"));
    await find("lockfile");
    await find("lockfile rewrites");
    expect(built).toBe(1);
  });

  it("finds a turn by words only its reply body holds, with a snippet saying where", async () => {
    await find("lockfile");
    expect(shownRows()).toEqual(["Fix the pre-commit hook"]);
    expect(snippets()).toEqual(["reply …rewrites the lockfile"]);
    const marks = [...rail.el.querySelectorAll(".toc-found .toc-hit")].map((m) => m.textContent);
    expect(marks).toEqual(["lockfile"]);
  });

  it("leaves out a snippet for an entry whose label already shows the words", async () => {
    await find("search box");
    expect(shownRows()).toEqual(["Add a search box"]);
    expect(snippets()).toEqual([]);
    await find("prettier");
    expect(snippets()).toEqual([]);
  });

  it("jumps to the entry, asking for it to be opened if the words are hidden", async () => {
    await find("git wip");
    rail.el.querySelector<HTMLElement>(".toc-k-found .toc-link")!.click();
    expect(jumps.at(-1)).toEqual({ id: "b", hit: { ids: ["b"], tokens: ["git", "wip"], reveal: true, count: 2 } });
  });

  it("searches tool output only when switched on, and says how many turns that would add", async () => {
    await find("econnrefused");
    expect(shownRows()).toEqual([]);
    expect(scope().getAttribute("aria-pressed")).toBe("false");
    expect(scope().textContent).toBe("tool output +1");
    expect(scope().title).toMatch(/^1 more turn matches in tool output/);
    scope().click();
    expect(scope().getAttribute("aria-pressed")).toBe("true");
    expect(shownRows()).toEqual(["Fix the pre-commit hook"]);
    expect(snippets()).toEqual(["Bash output …with code 1 ECONNREFUSED"]);
    expect(scope().textContent).toBe("tool output");
  });

  it("offers no tool output switch for a view that holds no tool output", async () => {
    const brief = renderToc(turns, () => {}, { ...opts(), index: () => index.filter((d) => d.id !== "b") });
    document.body.append(brief.el);
    const input = brief.el.querySelector<HTMLInputElement>(".toc-search")!;
    input.value = "hook";
    input.dispatchEvent(new Event("input"));
    await new Promise((r) => requestAnimationFrame(() => r(undefined)));
    expect(brief.el.querySelector<HTMLElement>(".toc-output")!.hidden).toBe(true);
    await find("hook");
    expect(scope().hidden).toBe(false);
  });

  it("shows far-apart hits in a long entry as separate lines of one link, and counts the rest", async () => {
    const long = ["alpha", "beta", "gamma", "delta", "epsilon"].map((w) => `${"filler words ".repeat(8)}needle ${w}`).join(" ");
    const big = renderToc(turns, (id, hit) => jumps.push({ id, hit }), { ...opts(), index: () => [doc(2, "big", [{ source: "reply", text: long }])] });
    document.body.append(big.el);
    const input = big.el.querySelector<HTMLInputElement>(".toc-search")!;
    input.value = "needle";
    input.dispatchEvent(new Event("input"));
    await new Promise((r) => requestAnimationFrame(() => r(undefined)));
    const row = big.el.querySelector<HTMLElement>(".toc-found .toc-k-found")!;
    expect(row.querySelectorAll(".toc-link")).toHaveLength(1);
    expect(row.querySelector(".toc-x.is-multi")).not.toBeNull();
    const lines = [...row.querySelectorAll(".toc-xline")];
    expect(lines).toHaveLength(2);
    expect(lines.every((l) => l.querySelector(".toc-hit")?.textContent === "needle")).toBe(true);
    expect(row.querySelector(".toc-xmore")!.textContent).toBe("+3 more matches");
    expect(row.textContent!.length).toBeLessThan(long.length / 2);
    row.querySelector<HTMLElement>(".toc-link")!.click();
    expect(jumps.at(-1)).toEqual({ id: "big", hit: { ids: ["big"], tokens: ["needle"], reveal: true, count: 5 } });
  });

  it("shows a few snippets per turn, then opens the rest on request", async () => {
    await find("staging deploy");
    expect(snippets(2)).toHaveLength(3);
    const more = rowsOf()[2]!.querySelector<HTMLButtonElement>(".toc-more button")!;
    expect(more.textContent).toBe("+2 more in this turn");
    more.click();
    expect(snippets(2)).toHaveLength(5);
    expect(rowsOf()[2]!.querySelector(".toc-more")).toBeNull();
  });

  it("counts turns and entries while searching, and hides the count otherwise", async () => {
    const status = rail.el.querySelector<HTMLElement>(".toc-status")!;
    expect(status.hidden).toBe(true);
    await find("hook");
    expect(status.hidden).toBe(false);
    const count = rail.el.querySelector<HTMLElement>(".toc-count")!;
    expect(count.textContent).toBe("1 turn");
    expect(count.title).toBe("2 entries hold every word");
    await find("");
    expect(status.hidden).toBe(true);
    expect(snippets()).toEqual([]);
  });

  it("says Search, not Filter, when it searches the whole session", () => {
    expect(box().placeholder).toBe("Search…");
    expect(search().placeholder).toBe("Filter…");
  });
});

describe("the detail setting as the search's scope", () => {
  const doc = (turn: number, id: string, source: string, text: string, output?: boolean): SearchDoc => {
    const f = { source, text, folded: fold(text), ...(output ? { output: true } : {}) };
    return { turn, id, fields: [f], inputs: output ? "" : f.folded, all: f.folded };
  };
  const index: SearchDoc[] = [
    doc(0, "turn-0-prompt", "prompt", "Fix the pre-commit hook. It fails when prettier runs twice on the lockfile"),
    doc(0, "a", "reply", "The hook runs prettier twice, so the second run rewrites the lockfile"),
    doc(1, "c", "reply", "Done: the search box filters rows and the lockfile is untouched"),
    doc(2, "d", "Bash output", "lockfile unchanged", true),
  ];
  let details: string[];
  let rail: ReturnType<typeof renderToc>;
  const box = () => rail.el.querySelector<HTMLInputElement>(".toc-search")!;
  const shownRows = () => [...rail.el.querySelectorAll<HTMLElement>(".toc-turn")].filter((r) => !r.hidden).map((r) => r.querySelector(".toc-label")!.textContent);
  const shownItems = () => [...rail.el.querySelectorAll<HTMLElement>(".toc-item")].filter((i) => !i.hidden && !i.closest("[hidden]"));
  const widen = () => rail.el.querySelector<HTMLButtonElement>(".toc-widen")!;
  const output = () => rail.el.querySelector<HTMLButtonElement>(".toc-output")!;
  const seg = (d: string) => rail.el.querySelector<HTMLButtonElement>(`.toc-seg [data-detail="${d}"]`)!;
  async function find(value: string) {
    box().value = value;
    box().dispatchEvent(new Event("input"));
    await new Promise((r) => requestAnimationFrame(() => r(undefined)));
  }

  beforeEach(() => {
    details = [];
    rail = renderToc(turns, () => {}, { detail: "prompts", onDetail: (d) => details.push(d), onClear: () => {}, index: () => index });
    document.body.append(rail.el);
  });

  it("searches only the prompts with \"prompts\", their full text included", async () => {
    expect(box().placeholder).toBe("Search prompts…");
    // "fails" is in the prompt's text, not its label.
    await find("fails");
    expect(shownRows()).toEqual(["Fix the pre-commit hook"]);
    expect(shownItems().map((i) => i.textContent)).toEqual(["prompt …hook. It fails when prettier…"]);
    // "filters rows" is only in a reply's label, and "untouched" in a reply's text.
    await find("filters rows");
    expect(shownRows()).toEqual([]);
    await find("untouched");
    expect(shownRows()).toEqual([]);
  });

  it("shows no reply or tool rows, even ones whose labels match", async () => {
    await find("prettier");
    expect(shownRows()).toEqual(["Fix the pre-commit hook"]);
    expect(shownItems().every((i) => i.classList.contains("toc-k-found") && i.textContent!.startsWith("prompt"))).toBe(true);
  });

  it("says how many more turns replies and tools would add, and switches to \"all\" on click", async () => {
    await find("lockfile");
    expect(shownRows()).toEqual(["Fix the pre-commit hook"]);
    expect(widen().hidden).toBe(false);
    expect(widen().textContent).toBe("replies & tools +1");
    // Tool output is a step further: not offered until replies and tools are searched.
    expect(output().hidden).toBe(true);
    widen().click();
    expect(details).toEqual(["all"]);
    expect(seg("all").getAttribute("aria-pressed")).toBe("true");
    expect(box().placeholder).toBe("Search…");
    expect(shownRows()).toEqual(["Fix the pre-commit hook", "Add a search box"]);
    expect(widen().hidden).toBe(true);
    expect(output().hidden).toBe(false);
    expect(output().textContent).toBe("tool output +1");
  });

  it("narrows back to the prompts when switched to \"prompts\" mid-search", async () => {
    seg("all").click();
    await find("lockfile");
    expect(shownRows()).toHaveLength(2);
    seg("prompts").click();
    expect(shownRows()).toEqual(["Fix the pre-commit hook"]);
    expect(details).toEqual(["all", "prompts"]);
  });

  it("offers nothing to add when replies and tools hold no more matches", async () => {
    await find("fails");
    expect(widen().textContent).toBe("replies & tools");
  });

  it("scopes a label-only rail the same way", async () => {
    const plain = renderToc(turns, () => {}, opts(() => {}, "prompts"));
    document.body.append(plain.el);
    const input = plain.el.querySelector<HTMLInputElement>(".toc-search")!;
    expect(input.placeholder).toBe("Filter prompts…");
    input.value = "prettier";
    input.dispatchEvent(new Event("input"));
    await new Promise((r) => requestAnimationFrame(() => r(undefined)));
    expect([...plain.el.querySelectorAll<HTMLElement>(".toc-turn")].every((r) => r.hidden)).toBe(true);
    expect(plain.el.querySelector(".toc-widen")!.textContent).toBe("replies & tools +1");
  });
});

