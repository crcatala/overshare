/** The rail filter's matching: punctuation-blind, order-blind, every word required. */
import { describe, expect, it } from "vitest";
import { fold, hitRanges, matchesAll, queryTokens, splitByRanges } from "../viewer/src/filter.ts";

const matches = (label: string, query: string) => matchesAll(fold(label), queryTokens(query));

describe("queryTokens", () => {
  it("splits on any run of non-alphanumerics and lowercases", () => {
    expect(queryTokens("  Pre-commit/HOOK  ")).toEqual(["pre", "commit", "hook"]);
  });

  it("drops repeats and returns nothing for a query with no words", () => {
    expect(queryTokens("fix fix FIX")).toEqual(["fix"]);
    expect(queryTokens(" - / . ")).toEqual([]);
    expect(queryTokens("")).toEqual([]);
  });

  it("keeps letters and digits from any script", () => {
    expect(queryTokens("naïve 日本語 x2")).toEqual(["naïve", "日本語", "x2"]);
  });
});

describe("matchesAll", () => {
  it("treats hyphens, underscores, dots and slashes as spacing", () => {
    expect(matches("Run the pre-commit hook", "pre commit")).toBe(true);
    expect(matches("Run the pre commit hook", "pre-commit")).toBe(true);
    expect(matches("edit src/viewer/toc.ts", "viewer toc")).toBe(true);
    expect(matches("snake_case_name", "snake case")).toBe(true);
  });

  it("ignores word order and case", () => {
    expect(matches("Auth: fix the login redirect", "LOGIN fix")).toBe(true);
  });

  it("requires every word", () => {
    expect(matches("fix the login", "fix logout")).toBe(false);
  });

  it("matches inside words, as substrings", () => {
    expect(matches("Refactoring the parser", "factor")).toBe(true);
  });

  it("does not join across a separator", () => {
    expect(matches("foo-bar", "foobar")).toBe(false);
  });

  it("finds tool-run labels", () => {
    expect(matches("Bash(git) ×3 · Edit", "git edit")).toBe(true);
    expect(matches("Bash(git) ×3 · Edit", "3")).toBe(true);
  });

  it("matches everything when there are no words", () => {
    expect(matchesAll(fold("anything"), [])).toBe(true);
  });
});

describe("hitRanges", () => {
  it("finds each word in the original text, whatever its case or punctuation", () => {
    expect(hitRanges("Fix the pre-commit hook", ["pre", "commit"])).toEqual([[8, 11], [12, 18]]);
  });

  it("merges overlapping and touching hits into one", () => {
    expect(hitRanges("abcdef", ["abc", "cde"])).toEqual([[0, 5]]);
    expect(hitRanges("abcdef", ["abc", "def"])).toEqual([[0, 6]]);
  });

  it("finds every occurrence", () => {
    expect(hitRanges("git add; git commit", ["git"])).toEqual([[0, 3], [9, 12]]);
  });

  it("finds nothing when a word is absent", () => {
    expect(hitRanges("hello", ["xyz"])).toEqual([]);
  });

  it("agrees with matchesAll: a folded match always has a highlight", () => {
    const label = "Bash(git) ×3 · Edit";
    expect(hitRanges(label, queryTokens("git edit"))).toEqual([[5, 8], [15, 19]]);
  });
});

describe("splitByRanges", () => {
  it("cuts text into plain and highlighted pieces", () => {
    expect(splitByRanges("abcdef", [[1, 3]])).toEqual([
      { text: "a", hit: false },
      { text: "bc", hit: true },
      { text: "def", hit: false },
    ]);
  });

  it("returns the text whole when nothing matched", () => {
    expect(splitByRanges("abc", [])).toEqual([{ text: "abc", hit: false }]);
  });

  it("does not emit an empty tail", () => {
    expect(splitByRanges("abc", [[0, 3]])).toEqual([{ text: "abc", hit: true }]);
  });
});
