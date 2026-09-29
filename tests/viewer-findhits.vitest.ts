// @vitest-environment jsdom
/** Outlining a clicked filter result's words in the transcript. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearHits, pulseHits, showHits } from "../viewer/src/findhits.ts";
import { h } from "../viewer/src/el.ts";

const entry = (id: string, ...body: (Node | string)[]) => h("div", { class: "entry", id }, h("div", { class: "gut", "aria-hidden": "true" }, "tool"), h("div", { class: "body" }, ...body));

let root: HTMLElement;
const hits = () => [...root.querySelectorAll(".find-hit")].map((m) => m.textContent);

beforeEach(() => {
  root = h(
    "div",
    { class: "transcript" },
    h(
      "section",
      { class: "turn", id: "turn-0" },
      entry("turn-0-prompt", h("p", {}, "Fix the pre-commit hook and add a Regression test")),
      entry("s-0-0", h("p", {}, "The hook runs prettier twice, then the hook exits")),
      entry("s-0-1", h("pre", {}, "git commit -m 'hook'")),
    ),
  );
  document.body.append(root);
});
afterEach(() => {
  clearHits();
  document.body.replaceChildren();
});

describe("showHits", () => {
  it("wraps the words in the entry, whatever their case, and leaves the text as it was", () => {
    const before = root.textContent;
    showHits(["s-0-0"], ["hook", "prettier"]);
    expect(hits()).toEqual(["hook", "prettier", "hook"]);
    expect(root.textContent).toBe(before);
  });

  it("looks only inside the entries it is given", () => {
    showHits(["s-0-1"], ["hook"]);
    expect(hits()).toEqual(["hook"]);
    expect(root.querySelector("#s-0-0")!.querySelector(".find-hit")).toBeNull();
  });

  it("looks in every entry of a run", () => {
    showHits(["s-0-0", "s-0-1"], ["hook"]);
    expect(hits()).toEqual(["hook", "hook", "hook"]);
  });

  it("takes a turn's id to mean its first entry, the prompt", () => {
    showHits(["turn-0"], ["hook", "regression"]);
    expect(hits()).toEqual(["hook", "Regression"]);
    expect(root.querySelector("#s-0-0")!.querySelector(".find-hit")).toBeNull();
  });

  it("skips the gutter", () => {
    showHits(["s-0-0"], ["tool"]);
    expect(hits()).toEqual([]);
  });

  it("outlines words of two or more characters only", () => {
    showHits(["s-0-0"], ["t", "ru"]);
    expect(hits()).toEqual(["ru"]);
  });

  it("ignores ids that are not in the page", () => {
    showHits(["nope"], ["hook"]);
    expect(hits()).toEqual([]);
  });

  it("replaces the earlier outlines, so only the latest result is marked", () => {
    showHits(["s-0-0"], ["prettier"]);
    showHits(["turn-0-prompt"], ["regression"]);
    expect(hits()).toEqual(["Regression"]);
  });

  it("stops at a cap on a very repetitive entry", () => {
    root.append(entry("big", ...Array.from({ length: 500 }, () => h("span", {}, "word "))));
    showHits(["big"], ["word"]);
    expect(hits()).toHaveLength(200);
  });

  it("applies the cap inside a single text node, where long paragraphs and tool output live", () => {
    root.append(entry("one", "word ".repeat(5000)));
    showHits(["one"], ["word"]);
    expect(hits()).toHaveLength(200);
  });

  it("spends what is left of the cap across entries", () => {
    root.append(entry("a", "word ".repeat(150)), entry("b", "word ".repeat(150)));
    showHits(["a", "b"], ["word"]);
    expect(hits()).toHaveLength(200);
    expect(root.querySelectorAll("#b .find-hit")).toHaveLength(50);
  });

  it("skips hidden content and the screen-reader copy of a drawn table, but not the drawn grid", () => {
    root.append(
      entry(
        "tbl",
        h("table", { class: "sr-only" }, h("tbody", {}, h("tr", {}, h("td", {}, "needle")))),
        h("pre", { class: "at-grid", "aria-hidden": "true" }, "| needle |"),
        h("div", { hidden: true }, "needle in a collapsed block"),
      ),
    );
    showHits(["tbl"], ["needle"]);
    expect(root.querySelectorAll("#tbl .find-hit")).toHaveLength(1);
    expect(root.querySelector("#tbl .at-grid .find-hit")).not.toBeNull();
  });

  it("never turns text into markup", () => {
    root.append(entry("evil", "<img src=x onerror=alert(1)> payload"));
    showHits(["evil"], ["payload"]);
    expect(root.querySelector("#evil img")).toBeNull();
    expect(hits()).toEqual(["payload"]);
  });
});

describe("clearHits", () => {
  it("restores the original text nodes", () => {
    const p = root.querySelector("#s-0-0 p")!;
    showHits(["s-0-0"], ["hook"]);
    expect(p.childNodes.length).toBeGreaterThan(1);
    clearHits();
    expect(hits()).toEqual([]);
    expect(p.childNodes).toHaveLength(1);
    expect(p.textContent).toBe("The hook runs prettier twice, then the hook exits");
  });

  it("copes with entries a re-render removed", () => {
    showHits(["s-0-0"], ["hook"]);
    root.replaceChildren();
    expect(() => clearHits()).not.toThrow();
  });
});

describe("pulseHits", () => {
  it("starts the ripple on the current outlines", () => {
    showHits(["s-0-0"], ["hook"]);
    expect(root.querySelector(".find-hit.is-new")).toBeNull();
    pulseHits();
    expect(root.querySelectorAll(".find-hit.is-new")).toHaveLength(2);
  });
});
