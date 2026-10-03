import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { drive, KEY, listColumn, sampleSessions, summary } from "./browse-helpers.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const withDetails = () =>
  sampleSessions().map((s) =>
    s.id === "s1"
      ? { ...s, branch: "fix/invoice-currency", lastReply: "Fixed: the default currency was missing, and I added a regression test for the USD fallback." }
      : s.id === "s2"
        ? { ...s, branch: "refactor/money", branchGuess: true as const }
        : s,
  );

describe("the preview of the selected session", () => {
  it("shows the last reply under the prompts", () => {
    const d = drive({ sessions: withDetails() });
    const text = d.text();
    expect(text).toContain("last reply");
    expect(text).toContain("Fixed: the default currency was missing");
    expect(text.indexOf("latest prompt")).toBeLessThan(text.indexOf("last reply"));
  });

  it("leaves the section out when there is no reply", async () => {
    const d = drive({ sessions: withDetails() });
    await d.press(KEY.down, KEY.down);
    expect(d.text()).not.toContain("last reply");
  });

  it("says when the branch is a guess", async () => {
    const d = drive({ sessions: withDetails() });
    expect(d.text()).toContain("fix/invoice-currency");
    expect(d.text()).not.toContain("fix/invoice-currency (guess)");
    await d.press(KEY.down);
    expect(d.text()).toContain("refactor/money (guess)");
  });

  it("never pushes the footer off the screen, however long the preview is", () => {
    const long = Array.from({ length: 8 }, (_, i) => `prompt number ${i} with some words`);
    const d = drive({ sessions: [summary({ id: "long", title: "Long one", prompts: 8, promptHead: long, promptTail: long, lastReply: "a ".repeat(300) })] });
    for (const height of [14, 20, 24]) {
      const lines = d.lines(100, height);
      expect(lines, `height ${height}`).toHaveLength(height);
      expect(lines.at(-1), `height ${height}`).toContain("j/k move");
    }
  });
});

describe("the branch column of the list", () => {
  const rowOf = (lines: string[], title: string) => listColumn(lines).find((l) => l.includes(title))!;
  /** The first billing row (s1) whatever the width does to its title. */
  const s1Row = (lines: string[]) => listColumn(lines).find((l) => l.includes("▌"))!;

  it("shows the branch next to the repo when the title still has room, a guess with a ~", () => {
    const d = drive({ sessions: withDetails() });
    const lines = d.lines(180, 34);
    expect(rowOf(lines, "Fix invoice currency bug")).toContain(" fix/invoice-cur… ");
    expect(rowOf(lines, "Refactor money helpers")).toContain("~refactor/money");
    expect(rowOf(lines, "Fix invoice currency bug")).not.toContain("~fix");
  });

  it("leaves the column out where it would squeeze the titles", () => {
    const d = drive({ sessions: withDetails() });
    for (const width of [80, 100, 130]) {
      const lines = d.lines(width, 34);
      expect(s1Row(lines).includes("fix/invoice"), `width ${width}`).toBe(false);
    }
  });

  it("leaves a session without a branch blank, and the title where it was", () => {
    const d = drive({ sessions: withDetails() });
    const row = rowOf(d.lines(180, 34), "Onboarding empty state");
    expect(row).toContain("Onboarding empty state");
    expect(row).not.toContain("~");
  });

  it("is searchable like the recorded one: branch:", async () => {
    const d = drive({ sessions: withDetails() });
    await d.press("/");
    await d.type("branch:money");
    await d.press(KEY.enter);
    expect(listColumn(d.lines()).filter((l) => /Refactor money helpers|Fix invoice/.test(l))).toHaveLength(1);
  });
});
