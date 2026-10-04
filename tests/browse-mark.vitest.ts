import { describe, expect, it } from "vitest";
import { st } from "../src/browse/kit.js";
import { HIT_ON, markLine, snippet, splitWords, unstyled } from "../src/browse/mark.js";
import { hitRanges } from "../src/sessions/query.js";

describe("hitRanges", () => {
  it("finds every occurrence of every word, case-insensitively, as merged ranges", () => {
    expect(hitRanges("Fix the Invoice invoice bug", ["invoice", "bug"])).toEqual([[8, 15], [16, 23], [24, 27]]);
    expect(hitRanges("foobar", ["foo", "oba"])).toEqual([[0, 5]]); // overlapping words merge into one stretch
  });

  it("takes a word literally: no regular expression, and no highlight for one letter", () => {
    expect(hitRanges("a.b axb", ["a.b"])).toEqual([[0, 3]]);
    expect(hitRanges("(x) [y] $z", ["(x)", "[y]", "$z"])).toEqual([[0, 3], [4, 7], [8, 10]]);
    expect(hitRanges("a b c", ["a"])).toEqual([]);
  });
});

describe("markLine", () => {
  it("changes only the look of the line: the text under the escape sequences is untouched", () => {
    const line = `${st.cyan("see ")}${st.bold("the invoice")} handler`;
    const { line: out, hits } = markLine(line, ["invoice", "handler"]);
    expect(hits).toBe(2);
    expect(unstyled(out)).toBe(unstyled(line));
    expect(out.split(HIT_ON)).toHaveLength(3);
  });

  it("gives colours and weight back after a hit", () => {
    const { line } = markLine(`\x1b[32mgreen word here\x1b[39m`, ["word"]);
    expect(line).toBe(`\x1b[32mgreen ${HIT_ON}word\x1b[32m\x1b[49m here\x1b[39m`);
    expect(markLine(`\x1b[1mbold hit\x1b[22m`, ["hit"]).line).toBe(`\x1b[1mbold ${HIT_ON}hit\x1b[39m\x1b[49m\x1b[1m\x1b[22m`);
    // a 256-colour foreground and a diff's background survive too
    const diff = markLine(`\x1b[48;5;22m\x1b[38;5;114mconst usd = 1\x1b[39m\x1b[49m`, ["usd"]).line;
    expect(diff).toContain(`${HIT_ON}usd\x1b[38;5;114m\x1b[48;5;22m`);
  });

  it("keeps a selected row's background after a hit: its tint comes back after every background reset", () => {
    const row = st.sel(markLine("pick the invoice row", ["invoice"]).line);
    expect(row).toContain(`${HIT_ON}invoice\x1b[39m\x1b[49m\x1b[48;5;238m row`);
  });

  it("finds a word that the text colours in the middle, and keeps the hit's colours through the colour change", () => {
    const { line, hits } = markLine(`fo\x1b[31mo\x1b[39mbar`, ["foo"]);
    expect(hits).toBe(1);
    // the hit ends before the text's own reset, so the colour it gives back is the one that reset then ends
    expect(line).toBe(`${HIT_ON}fo\x1b[31m${HIT_ON}o\x1b[31m\x1b[49m\x1b[39mbar`);
  });

  it("marks nothing before `from`, so a row's marker and turn number are not searched", () => {
    expect(markLine("[User] user asked", ["user"], 7).hits).toBe(1);
    expect(markLine("[User] user asked", ["user"]).hits).toBe(2);
  });

  it("leaves a line alone when there is nothing to mark", () => {
    expect(markLine("plain", [])).toEqual({ line: "plain", hits: 0 });
    expect(markLine("plain", ["x"])).toEqual({ line: "plain", hits: 0 }); // one letter is not highlighted
    expect(markLine("plain", ["absent"])).toEqual({ line: "plain", hits: 0 });
  });

  it("does not read hyperlinks as text", () => {
    const link = "\x1b]8;;https://example.com/invoice\x07see invoice\x1b]8;;\x07";
    const { line, hits } = markLine(link, ["invoice"]);
    expect(hits).toBe(1);
    expect(line.startsWith("\x1b]8;;https://example.com/invoice\x07see ")).toBe(true);
  });
});

describe("snippet", () => {
  const text = "please look at the money helpers in the billing service and then fix the rounding of the invoice total before the release";

  it("shows a short stretch around the first hit, cut at word boundaries", () => {
    const s = snippet(text, ["invoice"], 40)!;
    expect(s).toContain("invoice");
    expect(s.startsWith("…")).toBe(true);
    expect(s.length).toBeLessThanOrEqual(44);
    expect(s).not.toMatch(/\b(?:rou|ndi)\b/);
  });

  it("returns short text whole, and nothing when the words are not in it", () => {
    expect(snippet("fix the  invoice", ["invoice"], 40)).toBe("fix the invoice");
    expect(snippet(text, ["absent"], 40)).toBeUndefined();
  });
});

describe("splitWords", () => {
  it("lower-cases and drops repeats", () => {
    expect(splitWords("  Foo bar FOO ")).toEqual(["foo", "bar"]);
  });
});
