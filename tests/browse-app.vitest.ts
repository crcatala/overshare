import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { drive, KEY, manySessions, order, selectedNumber, summary, TITLES } from "./browse-helpers.js";
import { memorySettings } from "../src/browse/settings.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

// Newest first, workers hidden: s1 s2 s3 s4 s5 s6 s7
const BY_RECENCY = ["Fix invoice currency bug", "Refactor money helpers", "Onboarding empty state", "Auth token refresh race", "Bucket policy for R2", "Compare terminal multiplexers", "Write the worktree playbook"];

describe("session list", () => {
  it("lists sessions newest first and hides subagent workers", () => {
    const d = drive();
    const lines = d.lines();
    expect(order(lines, TITLES)).toEqual(BY_RECENCY);
    expect(d.text()).toContain("7/8"); // 7 shown of 8 indexed
  });

  it("h cycles harness filters and keeps the cursor on the same session when it stays visible", async () => {
    const d = drive();
    await d.press(KEY.down, KEY.down, KEY.down); // Auth token refresh race (pi)
    await d.press("h"); // claude-code: Auth is filtered out
    expect(order(d.lines(), TITLES)).toEqual(["Fix invoice currency bug", "Onboarding empty state", "Bucket policy for R2", "Write the worktree playbook"]);
    expect(d.text()).toContain("harness: claude");
    await d.press("h"); // pi
    expect(order(d.lines(), TITLES)).toEqual(["Refactor money helpers", "Auth token refresh race", "Compare terminal multiplexers"]);
    await d.press("h"); // back to all
    expect(order(d.lines(), TITLES)).toHaveLength(7);
  });

  it("Shift+R opens a repo dialog with counts; / filters it and enter applies the choice", async () => {
    const d = drive();
    await d.press("R");
    const dialog = d.text();
    expect(dialog).toContain("Repo (4)");
    expect(dialog).toMatch(/billing\s+2/); // the worker session does not count
    await d.press("/");
    await d.type("inf");
    await d.press(KEY.enter); // leave the filter box
    expect(d.text()).not.toMatch(/[○●] billing/);
    expect(d.text()).toMatch(/[○●] infra/);
    await d.press(KEY.enter); // choose "infra"
    expect(d.text()).toContain("repo: infra");
    expect(order(d.lines(), TITLES)).toEqual(["Bucket policy for R2", "Write the worktree playbook"]);
  });

  it("r cycles repos by frequency and x clears filters but keeps the view options", async () => {
    const d = drive();
    await d.press("g", "o"); // group: date, sort: last updated
    await d.press("r");
    expect(d.text()).toMatch(/repo: (billing|web|infra)/);
    await d.press("x");
    expect(d.text()).toContain("repo: all");
    expect(d.text()).toContain("group: date");
    expect(d.text()).toContain("sort: last updated");
  });

  it("grouping keeps the selection on the same session, even when rows above it move", async () => {
    const d = drive();
    await d.press(KEY.down, KEY.down, KEY.down); // Auth token refresh race
    const selected = () => d.lines().some((l) => l.includes("▌") && l.split(" │ ")[0]!.includes("Auth token refresh race")) && d.lines().some((l) => l.includes("│ Auth token refresh race"));
    expect(selected()).toBe(true);
    await d.press("G", KEY.down, KEY.down, KEY.enter); // group: repo
    expect(selected()).toBe(true);
  });

  it("t limits to recent sessions relative to the clock", async () => {
    const d = drive();
    await d.press("t"); // 24h
    expect(order(d.lines(), TITLES)).toEqual(["Fix invoice currency bug", "Refactor money helpers"]);
    await d.press("t"); // 7d
    expect(order(d.lines(), TITLES)).toHaveLength(5);
  });

  it("s filters by whether the session was shared, using shares.json", async () => {
    const d = drive({ shares: { "claude-code:s3": [{ url: "https://v/#s3", mode: "brief", target: "gist", sharedAt: new Date().toISOString() }] } });
    expect(d.text()).toContain("✓");
    await d.press("s"); // not shared
    expect(order(d.lines(), TITLES)).not.toContain("Onboarding empty state");
    await d.press("s"); // shared
    expect(order(d.lines(), TITLES)).toEqual(["Onboarding empty state"]);
  });

  it("searches free words across titles and prompts, and understands filter tokens", async () => {
    const d = drive();
    await d.press("/");
    await d.type("POST invoices"); // only in s1's first prompt
    await d.press(KEY.enter);
    expect(order(d.lines(), TITLES)).toEqual(["Fix invoice currency bug"]);
    await d.press(KEY.esc); // clears the search instead of quitting
    expect(order(d.lines(), TITLES)).toHaveLength(7);
    await d.press("/");
    await d.type("harness:pi since:2d");
    await d.press(KEY.enter);
    expect(order(d.lines(), TITLES)).toEqual(["Refactor money helpers", "Auth token refresh race"]);
  });

  it("starts from the initial query and harness options", () => {
    const d = drive({ query: "billing", harness: "pi" });
    expect(order(d.lines(), TITLES)).toEqual(["Refactor money helpers"]);
  });

  it("shows an empty state that explains how to recover", async () => {
    const d = drive({ query: "zzzz-no-such-thing" });
    expect(d.text()).toContain("no sessions match");
    expect(d.text()).toContain("x clears");
  });
});

describe("grouping", () => {
  it("g groups by date with headers in order, without reordering sessions", async () => {
    const d = drive();
    await d.press("g");
    const col = d.lines().map((l) => l.split(" │ ")[0]!).join("\n");
    const at = (h: string) => col.indexOf(`── ${h}`);
    expect(at("Today")).toBeGreaterThanOrEqual(0);
    expect(at("Today")).toBeLessThan(at("Yesterday"));
    expect(at("Yesterday")).toBeLessThan(at("This week"));
    expect(at("This week")).toBeLessThan(at("This month"));
    expect(at("This month")).toBeLessThan(at("Older"));
    expect(order(d.lines(), TITLES)).toEqual(BY_RECENCY);
  });

  it("Shift+G regroups by repo: members of a repo become adjacent, and the selection does not move", async () => {
    const d = drive();
    await d.press(KEY.down, KEY.down, KEY.down); // Auth token refresh race
    await d.press("G");
    await d.press(KEY.down, KEY.down, KEY.enter); // none → date → repo
    expect(d.text()).toContain("group: repo");
    const titles = order(d.lines(), TITLES);
    // billing sessions (Fix invoice…, Refactor money…) are adjacent, as are web's and infra's.
    const adjacent = (a: string, b: string) => Math.abs(titles.indexOf(a) - titles.indexOf(b)) === 1;
    expect(adjacent("Fix invoice currency bug", "Refactor money helpers")).toBe(true);
    expect(adjacent("Onboarding empty state", "Compare terminal multiplexers")).toBe(true);
    expect(adjacent("Bucket policy for R2", "Write the worktree playbook")).toBe(true);
    // The preview pane still shows the session that was selected before regrouping.
    expect(d.lines().some((l) => l.includes("│ Auth token refresh race"))).toBe(true);
  });
});

describe("sorting", () => {
  it("o cycles sort fields; text fields start A→Z and numeric fields largest first", async () => {
    const d = drive();
    await d.press("o"); // last updated (desc)
    expect(d.text()).toContain("sort: last updated ↓");
    await d.press("o"); // title (asc)
    expect(d.text()).toContain("sort: title ↑");
    expect(order(d.lines(), TITLES)[0]).toBe("Auth token refresh race");
    await d.press("o", "o"); // repo, then file size (desc)
    expect(d.text()).toContain("sort: file size ↓");
    expect(order(d.lines(), TITLES).slice(0, 3)).toEqual(["Fix invoice currency bug", "Auth token refresh race", "Refactor money helpers"]);
  });

  it("Shift+O sets field and direction in one dialog, where space applies without closing", async () => {
    const d = drive();
    await d.press("O");
    expect(d.text()).toContain("Sort by");
    expect(d.text()).toContain("Direction");
    await d.press(...Array(4).fill(KEY.down), KEY.space); // default, updated, title, repo, → file size
    expect(d.text()).toContain("Sort by"); // still open
    expect(order(d.lines(), TITLES)[0]).toBe("Fix invoice currency bug"); // size desc
    await d.press(...Array(4).fill(KEY.down)); // file size → "ascending" in the Direction section
    await d.press(KEY.enter);
    expect(d.text()).not.toContain("Direction"); // closed
    expect(d.text()).toContain("sort: file size ↑");
    expect(order(d.lines(), TITLES)[0]).toBe("Write the worktree playbook");
  });

  it("keeps groups intact when sorting inside them", async () => {
    const d = drive();
    await d.press("g", "g"); // group by repo
    await d.press("o", "o", "o", "o", "o"); // … through to prompts (desc)
    expect(d.text()).toContain("sort: prompts ↓");
    const titles = order(d.lines(), TITLES);
    // billing first appears via its top session; inside the group higher prompt counts come first.
    expect(titles.indexOf("Fix invoice currency bug")).toBeLessThan(titles.indexOf("Refactor money helpers"));
    expect(Math.abs(titles.indexOf("Fix invoice currency bug") - titles.indexOf("Refactor money helpers"))).toBe(1);
  });
});

describe("robustness", () => {
  it("a failing action shows an error in the footer and leaves the app usable", async () => {
    const d = drive({
      preflight: () => {
        throw new Error("boom from preflight");
      },
    });
    await d.press("p"); // the flow constructor throws
    expect(d.text()).toContain("error: Error: boom from preflight");
    await d.press("j");
    expect(d.text()).not.toContain("boom from preflight"); // cleared by the next key
    expect(d.app.flow).toBeUndefined();
  });

  it("q clears filters first, then asks before quitting", async () => {
    const d = drive({ query: "billing" });
    let quit = 0;
    d.app.onQuit = () => quit++;
    await d.press("q"); // clears the query
    expect(d.text()).not.toContain("Quit agent-share?");
    await d.press("q"); // nothing left to clear: confirm first
    expect(quit).toBe(0);
    expect(d.text()).toContain("Quit agent-share?");
    await d.press("n"); // stay
    expect(d.text()).not.toContain("Quit agent-share?");
    await d.press(KEY.esc, KEY.esc); // esc asks as well; esc on the dialog stays
    expect(quit).toBe(0);
    await d.press("q", "y");
    expect(quit).toBe(1);
  });

  it("the quit prompt takes enter or a second q as yes, and swallows other keys", async () => {
    for (const yes of [KEY.enter, "q"]) {
      const d = drive();
      let quit = 0;
      d.app.onQuit = () => quit++;
      await d.press("q", "j", "x", "/"); // stray keys do nothing while asking
      expect(quit).toBe(0);
      expect(d.text()).toContain("Quit agent-share?");
      await d.press(yes);
      expect(quit).toBe(1);
    }
  });

  it("quits straight away when confirmation is switched off in the settings", async () => {
    const settings = memorySettings({ confirmQuit: false });
    const d = drive({ settings });
    let quit = 0;
    d.app.onQuit = () => quit++;
    await d.press("q");
    expect(quit).toBe(1);
    expect(d.text()).not.toContain("Quit agent-share?");
  });

  it("? shows the key help and any key dismisses it", async () => {
    const d = drive();
    await d.press("?");
    expect(d.text()).toContain("Keys");
    expect(d.text()).toContain("Shift: pick from a dialog");
    await d.press("j");
    expect(d.text()).not.toContain("Shift: pick from a dialog");
  });

  it("the help lists the paging keys and the settings key", async () => {
    const d = drive();
    await d.press("?");
    expect(d.text()).toMatch(/space\s+b\s+page down/);
    expect(d.text()).toMatch(/settings: confirm before quitting/);
  });
});

describe("filter chips and the clear-filters hint", () => {
  const raw = (d: ReturnType<typeof drive>) => d.app.render(130).join("\n");

  it("shows each chip's hotkey letter in bold + underline, on and off chips alike", async () => {
    const d = drive();
    const hot = (ch: string) => `\x1b[1;4m${ch}\x1b[22;24m`;
    for (const [word, key] of [["harness", "h"], ["repo", "r"], ["time", "t"], ["shared", "s"], ["group", "g"], ["sort", "o"]] as const) {
      const i = word.indexOf(key);
      expect(raw(d), word).toContain(`${word.slice(0, i)}${hot(key)}${word.slice(i + 1)}:`);
    }
    await d.press("h"); // an active chip keeps its hotkey too
    expect(raw(d)).toContain(`${hot("h")}arness: claude`);
    expect(d.text()).toContain("harness: claude"); // plain text is unchanged
  });

  it("offers x in the footer only while something can be cleared", async () => {
    const d = drive();
    const footer = () => d.lines().at(-1)!;
    expect(footer()).not.toContain("clear filters");
    await d.press("h");
    expect(footer()).toMatch(/x clear filters/);
    await d.press("x");
    expect(footer()).not.toContain("clear filters");
    await d.press("/");
    await d.type("billing");
    await d.press(KEY.enter);
    expect(footer()).toMatch(/x clear filters/); // a search counts too
  });

  it("while typing a search with no results, points at esc rather than x", async () => {
    const d = drive();
    await d.press("/");
    await d.type("zzzzqqq");
    expect(d.text()).toContain("no sessions match — esc clears the search");
    expect(d.text()).not.toContain("x clears filters");
    await d.press(KEY.enter); // leave the search box with the text kept: now x works
    expect(d.text()).toContain("x clears filters");
  });
});

describe("selection after filtering", () => {
  const many = manySessions(120);

  it("jumps back to the first session and scrolls it into view after any filter or search change", async () => {
    const changes: Array<[string, (d: ReturnType<typeof drive>) => Promise<void>]> = [
      ["h", (d) => d.press("h")],
      ["r", (d) => d.press("r")],
      ["t", (d) => d.press("t")],
      ["s", (d) => d.press("s")],
      ["H dialog", (d) => d.press("H", KEY.down, KEY.enter)],
      ["search", async (d) => { await d.press("/"); await d.type("Session"); }],
    ];
    for (const [name, change] of changes) {
      const d = drive({ sessions: many });
      await d.press(...Array(70).fill("j"));
      expect(selectedNumber(d.lines(120, 20)), name).toBe(70);
      await change(d);
      const lines = d.lines(120, 20);
      const first = Number(listColumn0(lines).match(/Session number (\d+)/)![1]);
      expect(selectedNumber(lines), `${name}: selected`).toBe(first);
      expect(first, `${name}: top of the list`).toBe(0);
    }
  });

  it("also resets when x clears the filters", async () => {
    const d = drive({ sessions: many, harness: "pi" });
    await d.press(...Array(30).fill("j"));
    await d.press("x");
    expect(selectedNumber(d.lines(120, 20))).toBe(0);
  });

  it("keeps the selection when only the grouping changes", async () => {
    const d = drive({ sessions: many });
    await d.press(...Array(30).fill("j"));
    await d.press("g");
    expect(selectedNumber(d.lines(120, 20))).toBe(30);
  });

  it("jumps back to the first session when the sort changes: o, and both sections of the O dialog", async () => {
    const changes: Array<[string, (d: ReturnType<typeof drive>) => Promise<void>]> = [
      ["o", (d) => d.press("o")],
      ["O field", (d) => d.press("O", KEY.down, KEY.enter)],
      ["O direction", (d) => d.press("O", ...Array(8).fill(KEY.down), KEY.enter)], // past the 8 fields onto "ascending"
    ];
    for (const [name, change] of changes) {
      const d = drive({ sessions: many });
      await d.press(...Array(70).fill("j"));
      expect(selectedNumber(d.lines(120, 20)), name).toBe(70);
      await change(d);
      const lines = d.lines(120, 20);
      expect(selectedNumber(lines), `${name}: selected`).toBe(Number(listColumn0(lines).match(/Session number (\d+)/)![1]));
      expect(lines.some((l) => l.includes("▌")), `${name}: visible`).toBe(true);
    }
  });
});

/** First list-column line that holds a session row. */
function listColumn0(lines: string[]): string {
  return lines.map((l) => l.split(" │ ")[0]!).find((l) => /Session number/.test(l)) ?? "";
}

describe("paging", () => {
  const many = manySessions(120);
  // At 20 rows the list shows 15 (20 − 3 header lines − rule − footer).
  const at = (d: ReturnType<typeof drive>) => selectedNumber(d.lines(120, 20));

  it("space, PgDn and ctrl-f page down; b, PgUp and ctrl-b page up", async () => {
    for (const [down, up] of [[KEY.space, "b"], [KEY.pageDown, KEY.pageUp], [KEY.ctrlF, KEY.ctrlB]] as const) {
      const d = drive({ sessions: many });
      d.app.attach(() => 20, () => {});
      await d.press(down);
      expect(at(d), `${down} once`).toBe(15);
      await d.press(down);
      expect(at(d), `${down} twice`).toBe(30);
      await d.press(up);
      expect(at(d), `${up}`).toBe(15);
      await d.press(up, up);
      expect(at(d), "clamped at the top").toBe(0);
    }
  });

  it("ctrl-d and ctrl-u move half a page", async () => {
    const d = drive({ sessions: many });
    d.app.attach(() => 20, () => {});
    await d.press(KEY.ctrlD);
    expect(at(d)).toBe(7);
    await d.press(KEY.ctrlU);
    expect(at(d)).toBe(0);
  });

  it("clamps at the end, and never leaves the selection scrolled out of sight", async () => {
    const d = drive({ sessions: many });
    d.app.attach(() => 20, () => {});
    await d.press(...Array(20).fill(KEY.space));
    expect(at(d)).toBe(119);
  });

  it("counts group headers as rows and never lands on one", async () => {
    const d = drive({ sessions: many });
    d.app.attach(() => 20, () => {});
    await d.press("g"); // group by date: a header line before every day
    for (let i = 0; i < 6; i++) {
      await d.press(KEY.space);
      expect(at(d), `after ${i + 1} pages`).toBeTypeOf("number");
    }
    await d.press(...Array(40).fill(KEY.space));
    expect(at(d)).toBe(119);
    await d.press(...Array(40).fill("b"));
    expect(at(d)).toBe(0);
  });
});

describe("settings dialog", () => {
  it(", opens it; turning confirmation off is saved and skips the quit prompt", async () => {
    const settings = memorySettings();
    const d = drive({ settings });
    let quit = 0;
    d.app.onQuit = () => quit++;
    await d.press(",");
    expect(d.text()).toContain("Settings");
    expect(d.text()).toContain("Confirm before quitting");
    expect(d.text()).toContain("Date format");
    await d.press(KEY.down, KEY.enter); // yes → no
    expect(settings.get().confirmQuit).toBe(false);
    await d.press("q");
    expect(quit).toBe(1);
  });

  it("changes the updated column's date format immediately", async () => {
    const settings = memorySettings();
    const d = drive({ settings });
    expect(d.text()).toContain("1h ago");
    await d.press(",", ...Array(2 + 4).fill(KEY.down), KEY.enter); // past yes/no, then relative → … → date + time
    expect(settings.get().dateFormat).toBe("datetime");
    expect(d.text()).toContain("2026-09-30 11:00"); // NOW − 1h, in UTC
    expect(d.text()).not.toContain("1h ago");
    expect(d.text()).toContain("Fix invoice currency bug"); // the title column still has room
  });

  it("space applies without closing so formats can be tried", async () => {
    const settings = memorySettings();
    const d = drive({ settings });
    await d.press(",", KEY.down, KEY.down, KEY.down, KEY.space); // smart
    expect(settings.get().dateFormat).toBe("smart");
    expect(d.text()).toContain("Settings");
    expect(d.text()).toContain("11:00"); // today's sessions show the time
  });

  it("tells you when the settings could not be saved, and keeps working", async () => {
    const settings = { ...memorySettings(), update: () => false };
    const d = drive({ settings });
    await d.press(",", KEY.down, KEY.enter);
    expect(d.text()).toContain("could not save settings");
  });
});

describe("selected row highlight", () => {
  /** True when every visible character of `raw` is drawn on the selected-row background. */
  function fullyHighlighted(raw: string): boolean {
    let bg = "";
    let ok = true;
    for (const m of raw.matchAll(/\x1b\[([0-9;]*)m|([^\x1b])/g)) {
      if (m[2] !== undefined) {
        if (bg !== "48;5;238") ok = false;
        continue;
      }
      const code = m[1]!;
      if (code === "" || code === "0" || code === "49") bg = "";
      else if (code.startsWith("48;")) bg = code;
    }
    return ok;
  }

  it("covers the whole row when the repo name is truncated", async () => {
    const d = drive({ sessions: [summary({ id: "long", title: "A title after a long repo name", project: "agent-share-session-extra-long-repo-name" })] });
    const rows = d.app.render(130).filter((l) => stripTerminalSequences(l).includes("A title after"));
    expect(rows).toHaveLength(1);
    const list = rows[0]!.split(" │ ")[0]!;
    expect(stripTerminalSequences(list)).toContain("agent-share-s…");
    // The separator is gray and not part of the selection; only the list cell is checked.
    expect(fullyHighlighted(rows[0]!.slice(0, rows[0]!.indexOf("\x1b[49m") + "\x1b[49m".length))).toBe(true);
  });

  it("covers a truncated title and the shared mark too", async () => {
    const d = drive({ sessions: [summary({ id: "t", title: "T".repeat(200), project: "short" })], shares: { "claude-code:t": [{ url: "https://v/#t", mode: "brief", target: "gist", sharedAt: new Date().toISOString() }] } });
    const row = d.app.render(130).find((l) => stripTerminalSequences(l).includes("TTTT"))!;
    expect(fullyHighlighted(row.slice(0, row.indexOf("\x1b[49m") + "\x1b[49m".length))).toBe(true);
  });
});
