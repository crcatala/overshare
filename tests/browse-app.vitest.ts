import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drive, KEY, listColumn, manySessions, NOW, order, sampleSessions, selectedNumber, summary, TITLES } from "./browse-helpers.js";
import { IndexJob } from "../src/sessions/index.js";
import { ClaudeTranscript } from "./helpers.js";
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

  it("takes a paste into the search box", async () => {
    const d = drive();
    await d.press("/", "\x1b[200~POST invoices\n\x1b[201~");
    await d.press(KEY.enter);
    expect(order(d.lines(), TITLES)).toEqual(["Fix invoice currency bug"]);
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
    expect(d.text()).not.toContain("Quit overshare?");
    await d.press("q"); // nothing left to clear: confirm first
    expect(quit).toBe(0);
    expect(d.text()).toContain("Quit overshare?");
    await d.press("n"); // stay
    expect(d.text()).not.toContain("Quit overshare?");
    await d.press(KEY.esc, KEY.esc); // esc asks as well; esc on the dialog stays
    expect(quit).toBe(0);
    d.app.handleInput("q"); // no timers run between the keys: the index is still midway
    d.app.handleInput("y");
    expect(quit).toBe(1);
  });

  it("the quit prompt takes enter or a second q as yes, and swallows other keys", async () => {
    for (const yes of [KEY.enter, "q"]) {
      const d = drive();
      let quit = 0;
      d.app.onQuit = () => quit++;
      await d.press("q", "j", "x", "/"); // stray keys do nothing while asking
      expect(quit).toBe(0);
      expect(d.text()).toContain("Quit overshare?");
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
    expect(d.text()).not.toContain("Quit overshare?");
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

describe("while the index is still running", () => {
  const ALL = sampleSessions().map((x) => x.id);
  const selectedLine = (d: ReturnType<typeof drive>) => d.lines().find((l) => l.includes("▌"))!.split(" │ ")[0]!;

  it("paints the whole list at once from the stat-only rows, with a placeholder title and a progress count", () => {
    const d = drive({ pending: ALL });
    const text = d.text();
    expect(text).toContain("8/8"); // a worker session is not known to be one until it is read, so it is listed for now
    expect(text).toContain("reading sessions 0/8");
    expect(listColumn(d.lines()).filter((l) => l.includes("reading…"))).toHaveLength(8);
    expect(text).toContain("reading this session…"); // the preview of the selected row
    expect(text).not.toContain("Fix invoice currency bug");
    // The harness, time and the list order come from the stat alone.
    expect(selectedLine(d)).toContain("CC");
  });

  it("fills rows in as they are read, and drops the progress count when the last one arrives", () => {
    const d = drive({ pending: ALL });
    d.source.fill("s1");
    d.source.fill("s3");
    expect(order(d.lines(), TITLES)).toEqual(["Fix invoice currency bug", "Onboarding empty state"]);
    expect(d.text()).toContain("reading sessions 2/8");
    expect(d.text()).toContain("Fix invoice currency bug"); // the selected row's preview too
    for (const id of ALL) d.source.fill(id);
    expect(d.text()).not.toContain("reading sessions");
    expect(order(d.lines(), TITLES)).toEqual(BY_RECENCY);
    expect(d.text()).toContain("7/8"); // the worker is hidden once it is known to be one
  });

  it("keeps the selection on the same session while rows fill in, even when sorting reorders them", async () => {
    const d = drive({ pending: ALL });
    await d.press(KEY.down, KEY.down, KEY.down); // s1, w1 (not yet known to be a worker), s2, s3
    expect(d.app.current?.id).toBe("s3");
    d.source.fill("s1");
    d.source.fill("s3");
    expect(d.app.current?.id).toBe("s3");
    expect(selectedLine(d)).toContain("Onboarding empty state");
    await d.press("o", "o", "o", "o"); // sort by file size (known from the stat): s1 900k, s4, s2, s3 ...
    const id = d.app.current!.id;
    d.source.fill("s4");
    d.source.fill("s2");
    expect(d.app.current?.id).toBe(id);
  });

  it("moves, pages, and filters by harness/time/shared on rows that have not been read yet", async () => {
    const d = drive({ pending: ALL });
    await d.press("j", "j", "j", "j");
    expect(d.app.current?.id).toBe("s4");
    await d.press("h"); // claude-code only: a placeholder knows its harness
    expect(d.app.view.every((x) => x.harness === "claude-code")).toBe(true);
    await d.press("h");
    expect(d.app.view.every((x) => x.harness === "pi")).toBe(true);
    await d.press("x", "t"); // last 24h, from the file's mtime
    expect(d.app.view.map((x) => x.id)).toEqual(["s1", "w1", "s2"]);
    await d.press(KEY.end);
    expect(d.app.current?.id).toBe("s2");
  });

  it("searches the rows read so far, says so, and picks up the rest as they arrive", async () => {
    const d = drive({ pending: ALL });
    await d.press("/");
    await d.type("invoice");
    expect(d.app.view).toHaveLength(0);
    expect(d.text()).toContain("search covers the sessions read so far");
    expect(d.text()).toContain("no sessions match");
    d.source.fill("s2"); // "Refactor money helpers": no match
    expect(d.app.view).toHaveLength(0);
    d.source.fill("s1");
    expect(d.app.view.map((x) => x.id)).toEqual(["s1"]);
    expect(d.app.current?.id).toBe("s1");
    for (const id of ALL) d.source.fill(id);
    expect(d.text()).not.toContain("search covers");
  });

  it("will not open or publish a row that has not been read, and says why", async () => {
    const d = drive({ pending: ALL });
    await d.press(KEY.enter);
    expect(d.app.viewer).toBeUndefined();
    expect(d.text()).toContain("still reading this session");
    await d.press("p");
    expect(d.app.flow).toBeUndefined();
    expect(d.source.reviewed).toEqual([]);
    d.source.fill("s1");
    await d.press(KEY.enter);
    expect(d.app.viewer).toBeDefined();
  });

  it("an open viewer is not disturbed by rows filling in behind it", async () => {
    const d = drive({ pending: ["s2", "s3"] });
    await d.press(KEY.enter, "j");
    const before = d.text();
    d.source.fill("s2");
    d.source.fill("s3");
    expect(d.app.viewer).toBeDefined();
    expect(d.text()).toBe(before);
  });

  it("an open repo picker follows the index: repos and counts appear, and the cursor stays on its item", async () => {
    const d = drive({ pending: ALL });
    await d.press("R");
    expect(d.text()).toContain("Repo (0)"); // nothing is known about repos before the first rows are read
    for (const id of ["s1", "s2", "s3"]) d.source.fill(id);
    expect(d.text()).toContain("Repo (2)");
    expect(d.text()).toMatch(/billing\s+2/);
    await d.press("j", "j"); // billing, then web
    for (const id of ["s6", "s5", "s7"]) d.source.fill(id); // web 2, infra 2: infra now sorts in front of web
    expect(d.text()).toContain("Repo (3)");
    expect(d.text()).toMatch(/infra\s+2/);
    await d.press(KEY.enter); // still on web, though web moved down a row
    expect(d.text()).toContain("repo: web");
  });

  it("an open repo picker keeps its filter while rows arrive", async () => {
    const d = drive({ pending: ALL });
    await d.press("R", "/");
    await d.type("inf");
    expect(d.text()).toContain("no matches");
    d.source.fill("s5");
    d.source.fill("s7");
    expect(d.text()).toMatch(/infra\s+2/);
    expect(d.text()).not.toMatch(/billing\s/);
  });

  it("quitting mid-index stops the index so the cache keeps what was read", async () => {
    const dir = mkdtempSync(join(tmpdir(), "browse-quit-"));
    const claude = join(dir, "claude");
    mkdirSync(join(claude, "-home-x"), { recursive: true });
    for (let i = 0; i < 4; i++) {
      const file = join(claude, "-home-x", `sess-${i}.jsonl`);
      const t = new ClaudeTranscript(`sess-${i}`, "/home/tester/work/demo");
      t.meta("ai-title", { aiTitle: `Title ${i}` });
      t.user(`prompt ${i}`);
      writeFileSync(file, t.toJsonl());
      utimesSync(file, new Date(2026, 0, 1), new Date(2026, 0, 1, 12, 4 - i));
    }
    const cachePath = join(dir, "cache.json");
    const job = new IndexJob({ roots: { "claude-code": claude, pi: join(dir, "pi") }, cachePath, sliceMs: 0, saveEveryMs: 60_000 });
    const d = drive({ sessions: job.sessions, index: job });
    expect(d.text()).toContain("reading sessions 0/4");
    await vi.advanceTimersToNextTimerAsync();
    await vi.advanceTimersToNextTimerAsync();
    expect(d.text()).toContain("Title 1");
    expect(d.text()).toContain("reading sessions 2/4");
    let quit = 0;
    d.app.onQuit = () => quit++;
    d.app.handleInput("q"); // no timers run between the keys: the index is still midway
    d.app.handleInput("y");
    expect(quit).toBe(1);
    const cached = Object.keys(JSON.parse(readFileSync(cachePath, "utf8")).sessions);
    expect(cached.map((p) => p.match(/sess-(\d)/)![1]).sort()).toEqual(["0", "1"]);
    await vi.runAllTimersAsync();
    expect(job.sessions.filter((x) => !x.pending)).toHaveLength(2); // nothing is read after the quit
  });
});

describe("ctrl-r refresh (ass-gnso)", () => {
  const fresh = (id: string, title: string, mtimeMs: number) => summary({ id, title, project: "billing", mtimeMs });

  it("asks the index to refresh, and the footer and help list the key", async () => {
    const d = drive({ refresh: () => {} });
    expect(d.text(200)).toContain("ctrl-r refresh");
    await d.press(KEY.ctrlR);
    expect(d.source.refreshes).toBe(1);
    await d.press("?");
    expect(d.text()).toContain("ctrl-r");
    expect(d.text()).toContain("read sessions written since launch");
  });

  it("shows a session that appeared, and one that was rewritten, without moving the selection", async () => {
    const d = drive({
      refresh: (rows) => {
        rows.unshift(fresh("n1", "Brand new session", NOW)); // newest of all
        const at = rows.findIndex((s) => s.id === "s3");
        rows[at] = { ...rows[at]!, title: "Onboarding empty state (renamed)", mtimeMs: NOW - 1000 };
      },
    });
    await d.press(KEY.down, KEY.down); // Onboarding empty state
    expect(d.text()).toMatch(/▌.*Onboarding empty state/);
    await d.press(KEY.ctrlR);
    const titles = order(d.lines(), [...TITLES, "Brand new session", "Onboarding empty state (renamed)"]);
    expect(titles[0]).toBe("Brand new session");
    expect(titles).toContain("Onboarding empty state (renamed)");
    expect(d.text()).toMatch(/▌.*Onboarding empty state \(renamed\)/); // the cursor followed the session, not its position
    expect(d.text()).toContain("8/9");
  });

  it("keeps the search and the filters, and applies them to what arrives", async () => {
    const d = drive({ refresh: (rows) => void rows.unshift(fresh("n1", "Invoice export job", NOW)) });
    await d.press("h"); // claude-code only
    await d.press("/");
    await d.type("invoice");
    await d.press(KEY.enter);
    expect(order(d.lines(), [...TITLES, "Invoice export job"])).toEqual(["Fix invoice currency bug"]);
    await d.press(KEY.ctrlR);
    expect(order(d.lines(), [...TITLES, "Invoice export job"])).toEqual(["Invoice export job", "Fix invoice currency bug"]);
    expect(d.text()).toContain("harness: claude");
    expect(d.text()).toContain("/ invoice");
  });

  it("copes with the selected session having vanished", async () => {
    const d = drive({ refresh: (rows) => void rows.splice(rows.findIndex((s) => s.id === "s7"), 1) });
    await d.press(KEY.end); // Write the worktree playbook, the last row
    await d.press(KEY.ctrlR);
    expect(order(d.lines(), TITLES)).toEqual(BY_RECENCY.slice(0, 6));
    expect(d.text()).toMatch(/▌.*Compare terminal multiplexers/); // the nearest row is selected, nothing crashes
    await d.press(KEY.enter); // and it is a real session that opens
    expect(d.source.viewed.at(-1)!.id).toBe("s6");
  });

  it("does nothing while a dialog or the viewer has the keys", async () => {
    const d = drive({ refresh: () => {} });
    await d.press("R", KEY.ctrlR);
    expect(d.source.refreshes).toBe(0);
    await d.press(KEY.esc, KEY.enter, KEY.ctrlR); // the viewer
    expect(d.source.refreshes).toBe(0);
  });

  it("does not turn into search text while typing", async () => {
    const d = drive({ refresh: () => {} });
    await d.press("/", KEY.ctrlR);
    expect(d.source.refreshes).toBe(0);
    expect(d.text()).not.toContain("\x12");
  });

  it("with the real index: appended messages, a new transcript and a deleted one show up without leaving the browser", async () => {
    const dir = mkdtempSync(join(tmpdir(), "browse-refresh-"));
    const claude = join(dir, "claude", "-home-x");
    mkdirSync(claude, { recursive: true });
    const put = (id: string, title: string, minutes: number) => {
      const file = join(claude, `${id}.jsonl`);
      const t = new ClaudeTranscript(id, "/home/tester/work/demo");
      t.meta("ai-title", { aiTitle: title });
      t.user(`prompt of ${id}`);
      writeFileSync(file, t.toJsonl());
      utimesSync(file, new Date(2026, 0, 1), new Date(2026, 0, 1, 12, minutes));
      return file;
    };
    const running = put("sess-run", "Running session", 3);
    put("sess-other", "Other session", 2);
    const doomed = put("sess-doomed", "Doomed session", 1);
    const job = new IndexJob({ roots: { "claude-code": join(dir, "claude"), pi: join(dir, "pi") }, cachePath: join(dir, "cache.json"), sliceMs: 0 });
    const d = drive({ sessions: job.sessions, index: job });
    await vi.runAllTimersAsync();
    await d.press(KEY.down); // Other session
    expect(d.text()).toMatch(/▌.*Other session/);
    expect(d.text()).toContain("1 prompt");

    // Meanwhile, in another terminal: the running session gets another prompt and a better title, one appears, one is deleted.
    writeFileSync(running, `${readFileSync(running, "utf8")}${JSON.stringify({ type: "ai-title", aiTitle: "Running session, now titled" })}\n`);
    put("sess-fresh", "Fresh session", 10);
    rmSync(doomed);
    expect(d.text()).not.toContain("Fresh session"); // nothing changes until asked

    await d.press(KEY.ctrlR);
    await vi.runAllTimersAsync();
    const text = d.text();
    expect(text).toContain("Fresh session");
    expect(text).toContain("Running session, now titled");
    expect(text).not.toContain("Doomed session");
    expect(text).toMatch(/▌.*Other session/); // still on the session that was selected
    expect(text).not.toContain("reading sessions"); // and the refresh is over
  });
});
