import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WINDOW } from "../src/browse/dialogs.js";
import { drive, KEY, summary } from "./browse-helpers.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

/** `n` repos, the first with the most sessions, so the dialog lists them in a known order. */
const repos = (n: number) =>
  Array.from({ length: n }, (_, i) => summary({ id: `r${i}`, title: `Session in repo ${i}`, project: `repo-${String(i).padStart(2, "0")}${i % 7 === 0 ? "-with-a-much-longer-name-than-the-others" : ""}`, mtimeMs: Date.UTC(2026, 8, 30) - i * 3_600_000 }));

/** The dialog's box on screen: its lines from the top border to the bottom border, cut out of the full-width screen lines. */
function dialogBox(lines: string[]): string[] {
  const top = lines.findIndex((l) => /╭─ (Repo|Harness|Updated|Sort)/.test(l));
  const left = lines[top]!.indexOf("╭─ ");
  const bottom = lines.findIndex((l, i) => i > top && l.slice(left).startsWith("╰"));
  return lines.slice(top, bottom + 1).map((l) => l.slice(left, l.indexOf(l[left] === "╭" ? "╮" : l[left] === "╰" ? "╯" : "│", left + 1) + 1 || undefined));
}

describe("the repo dialog with a long list", () => {
  it("keeps a fixed height however tall the terminal is, and scrolls instead of growing", async () => {
    const d = drive({ sessions: repos(40) });
    await d.press("R");
    for (const height of [30, 60, 90]) {
      const box = dialogBox(d.lines(130, height));
      // two borders, the search row + blank, WINDOW rows, the meter row + blank, the footer
      expect(box.length, `height ${height}`).toBe(2 + 2 + WINDOW + 2 + 1);
    }
  });

  it("shows how far down the list the cursor is: a row of dots and n/total", async () => {
    const d = drive({ sessions: repos(40) });
    await d.press("R");
    expect(d.text()).toMatch(/●[ ○]* +1\/41/); // "any" + 40 repos
    await d.press(...Array(20).fill("j"));
    expect(d.text()).toMatch(/● ● ●[ ●○]* +21\/41/);
    await d.press(KEY.end);
    expect(d.text()).toMatch(/● ● ● ● ● ● ● ● ● ● +41\/41/);
  });

  it("does not hide list items behind '↑ n more' / '↓ n more' lines any more", async () => {
    const d = drive({ sessions: repos(40) });
    await d.press("R");
    expect(d.text()).not.toMatch(/↓ \d+ more/);
    expect(d.text()).not.toMatch(/↑ \d+ more/);
    expect(d.text()).toContain("any");
    expect(d.text()).toContain("repo-01");
  });

  it("pages through the list with PgDn / PgUp and ctrl-d / ctrl-u", async () => {
    const d = drive({ sessions: repos(40) });
    await d.press("R");
    await d.press(KEY.pageDown);
    expect(d.text()).toContain(`${WINDOW + 1}/41`);
    await d.press(KEY.ctrlD);
    expect(d.text()).toContain(`${WINDOW + 1 + WINDOW / 2}/41`);
    await d.press(KEY.ctrlU, KEY.pageUp);
    expect(d.text()).toContain("1/41");
  });

  it("is as big while filtering as before: typing in the filter does not make the box jump", async () => {
    const d = drive({ sessions: repos(40) });
    await d.press("R");
    const before = dialogBox(d.lines());
    await d.press("/");
    await d.type("repo-03");
    const after = dialogBox(d.lines());
    expect(after.length).toBe(before.length);
    expect(Math.max(...after.map((l) => l.length))).toBe(Math.max(...before.map((l) => l.length)));
    expect(after.join("\n")).toContain("repo-03");
    expect(after.join("\n")).not.toContain("repo-04");
  });

  it("is never narrower than the minimum, even for a short list", async () => {
    const d = drive();
    await d.press("H");
    const box = dialogBox(d.lines());
    expect(Math.max(...box.map((l) => l.trimEnd().length))).toBeGreaterThanOrEqual(44);
    expect(d.text()).not.toMatch(/●[ ○]* +\d+\/\d+/); // three rows: no meter
  });

  it("lines the counts up at the right edge", async () => {
    const d = drive();
    await d.press("R");
    const rows = dialogBox(d.lines()).filter((l) => /^│ +[› ] [●○] (any|billing|web|infra|auth)/.test(l));
    expect(rows.length).toBeGreaterThanOrEqual(4);
    const ends = new Set(rows.map((l) => l.replace(/ │.*$/, "").trimEnd().length));
    expect(ends.size).toBe(1);
  });
});

describe("fits the terminal", () => {
  const SIZES: Array<[number, number]> = [[40, 12], [60, 14], [80, 24], [132, 40], [200, 60]];
  it("a long repo dialog, filtering or not, at every size", async () => {
    const d = drive({ sessions: repos(40) });
    for (const keys of [["R"], ["R", "/"], ["R", KEY.end]]) {
      const e = drive({ sessions: repos(40) });
      await e.press(...keys);
      for (const [width, height] of SIZES) {
        e.app.attach(() => height, () => {});
        const lines = e.app.draw(width, height);
        expect(lines, `${keys} @ ${width}x${height}`).toHaveLength(height);
        expect(lines.filter((l) => visibleWidth(l) > width), `${keys} @ ${width}x${height}`).toEqual([]);
      }
    }
    expect(d.app.dialog).toBeUndefined();
  });
});

describe("the cursor marker", () => {
  const marked = (d: ReturnType<typeof drive>) => dialogBox(d.lines()).filter((l) => l.includes("›")).map((l) => l.replace(/[│ ]+$/, "").replace(/^│ +/, ""));

  it("sits on the item under the cursor in the repo dialog, whose items are rebuilt on every read", async () => {
    const d = drive({ sessions: repos(40) });
    await d.press("R");
    expect(marked(d)).toHaveLength(1);
    expect(marked(d)[0]).toMatch(/^› ● any/);
    await d.press("j", "j");
    expect(marked(d)).toHaveLength(1);
    expect(marked(d)[0]).toMatch(/^› ○ \S+/);
    await d.press(...Array(20).fill("j"), "k");
    expect(marked(d)).toHaveLength(1); // still exactly one, after scrolling
  });

  it("follows the cursor while filtering too", async () => {
    const d = drive({ sessions: repos(40) });
    await d.press("R", "/");
    await d.type("repo-1");
    await d.press(KEY.enter, "j");
    expect(marked(d)).toHaveLength(1);
  });
});
