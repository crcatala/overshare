import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { drive, KEY, order, TITLES } from "./browse-helpers.js";

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

  it("applying a dialog filter keeps the selection on the same session, even when rows above it disappear", async () => {
    const shared = { url: "https://v/#x", mode: "brief" as const, target: "gist" as const, sharedAt: new Date().toISOString() };
    const d = drive({ shares: { "claude-code:s1": [shared], "pi:s2": [shared] } }); // the two rows above the selection are shared
    await d.press(KEY.down, KEY.down); // Onboarding empty state (claude-code, not shared)
    // The selection marker is on that session's row, and the preview pane (right column) shows the same session.
    const selected = () => d.lines().some((l) => l.includes("▌") && l.split(" │ ")[0]!.includes("Onboarding empty state")) && d.lines().some((l) => l.includes("│ Onboarding empty state"));
    expect(selected()).toBe(true);
    await d.press("H", KEY.down, KEY.enter); // harness: Claude Code
    expect(d.text()).toContain("harness: claude");
    expect(selected()).toBe(true);
    await d.press("S", KEY.down, KEY.enter); // shared: not shared yet
    expect(d.text()).toContain("shared: no");
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

  it("q quits only when there is nothing to clear", async () => {
    const d = drive({ query: "billing" });
    let quit = 0;
    d.app.onQuit = () => quit++;
    await d.press("q"); // clears the query
    expect(quit).toBe(0);
    await d.press("q");
    expect(quit).toBe(1);
  });

  it("? shows the key help and any key dismisses it", async () => {
    const d = drive();
    await d.press("?");
    expect(d.text()).toContain("Keys");
    expect(d.text()).toContain("Shift: pick from a dialog");
    await d.press("j");
    expect(d.text()).not.toContain("Shift: pick from a dialog");
  });
});
