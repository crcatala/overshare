import { mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DATE_FORMATS, dateFormat } from "../src/browse/display.js";
import { DEFAULT_SETTINGS, fileSettings, loadSettings, memorySettings, normalizeSettings, settingsPath } from "../src/browse/settings.js";

process.env.TZ = "UTC";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "browse-settings-"));
});
afterEach(() => {
  chmodSync(dir, 0o700);
  rmSync(dir, { recursive: true, force: true });
});

describe("normalizeSettings", () => {
  it("defaults everything for a missing or non-object file", () => {
    for (const raw of [undefined, null, 5, "x", [], {}]) expect(normalizeSettings(raw)).toEqual(DEFAULT_SETTINGS);
  });

  it("keeps valid fields and defaults the invalid ones one by one", () => {
    expect(normalizeSettings({ confirmQuit: false, dateFormat: "nope", viewer: { indentReplies: true, indentTools: "yes" } })).toEqual({
      confirmQuit: false,
      dateFormat: "relative",
      viewer: { indentReplies: true, indentTools: false },
    });
    expect(normalizeSettings({ dateFormat: "datetime", viewer: [] }).dateFormat).toBe("datetime");
  });

  it("asks for confirmation before quitting by default", () => {
    expect(DEFAULT_SETTINGS.confirmQuit).toBe(true);
  });
});

describe("settingsPath", () => {
  it("honours AGENT_SHARE_BROWSE_SETTINGS, then XDG_CONFIG_HOME", () => {
    expect(settingsPath({ AGENT_SHARE_BROWSE_SETTINGS: "/x/b.json" })).toBe("/x/b.json");
    expect(settingsPath({ XDG_CONFIG_HOME: "/cfg" })).toBe("/cfg/agent-share/browse.json");
  });
});

describe("fileSettings", () => {
  it("starts from defaults when the file does not exist and creates it (and its directory) on the first change", () => {
    const path = join(dir, "nested", "browse.json");
    const store = fileSettings(path);
    expect(store.get()).toEqual(DEFAULT_SETTINGS);
    expect(existsSync(path)).toBe(false);
    expect(store.update({ confirmQuit: false })).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ ...DEFAULT_SETTINGS, confirmQuit: false });
  });

  it("persists across runs and merges nested viewer changes", () => {
    const path = join(dir, "browse.json");
    const a = fileSettings(path);
    a.update({ dateFormat: "short" });
    a.update({ viewer: { indentReplies: true } });
    a.update({ viewer: { indentTools: true } });
    const b = fileSettings(path);
    expect(b.get()).toEqual({ confirmQuit: true, dateFormat: "short", viewer: { indentReplies: true, indentTools: true } });
    expect(loadSettings(path)).toEqual(b.get());
  });

  it("survives a corrupt file and a hand-edited partial file", () => {
    const path = join(dir, "browse.json");
    writeFileSync(path, "{ not json");
    expect(fileSettings(path).get()).toEqual(DEFAULT_SETTINGS);
    writeFileSync(path, JSON.stringify({ confirmQuit: false }));
    expect(fileSettings(path).get()).toEqual({ ...DEFAULT_SETTINGS, confirmQuit: false });
  });

  it("rejects an invalid value instead of storing it", () => {
    const store = fileSettings(join(dir, "browse.json"));
    store.update({ dateFormat: "bogus" as never });
    expect(store.get().dateFormat).toBe("relative");
  });

  it("applies a change on top of the file as it is now, so a second browser's other settings survive", () => {
    const path = join(dir, "browse.json");
    const first = fileSettings(path);
    const second = fileSettings(path); // both opened before either changed anything
    first.update({ confirmQuit: false });
    second.update({ dateFormat: "short" });
    expect(loadSettings(path)).toEqual({ ...DEFAULT_SETTINGS, confirmQuit: false, dateFormat: "short" });
    expect(second.get().confirmQuit).toBe(false); // and it now reflects the other's change
    second.update({ viewer: { indentReplies: true } });
    first.update({ viewer: { indentTools: true } });
    expect(loadSettings(path).viewer).toEqual({ indentReplies: true, indentTools: true });
  });

  it("falls back to its own state when the file is gone or corrupt at the time of a change", () => {
    const path = join(dir, "browse.json");
    const store = fileSettings(path);
    store.update({ confirmQuit: false });
    rmSync(path);
    store.update({ dateFormat: "date" });
    expect(loadSettings(path)).toEqual({ ...DEFAULT_SETTINGS, confirmQuit: false, dateFormat: "date" });
    writeFileSync(path, "{ not json");
    store.update({ viewer: { indentTools: true } });
    expect(loadSettings(path)).toEqual({ ...DEFAULT_SETTINGS, confirmQuit: false, dateFormat: "date", viewer: { indentReplies: false, indentTools: true } });
  });

  it("keeps changes it could not save and writes them with the next successful save", () => {
    const blocker = join(dir, "blocked");
    writeFileSync(blocker, "x");
    const path = join(blocker, "browse.json"); // unwritable while `blocked` is a file
    const store = fileSettings(path);
    expect(store.update({ confirmQuit: false })).toBe(false);
    rmSync(blocker);
    expect(store.update({ dateFormat: "short" })).toBe(true);
    expect(loadSettings(path)).toEqual({ ...DEFAULT_SETTINGS, confirmQuit: false, dateFormat: "short" });
  });

  it("reports a failed save but keeps the change for this run", () => {
    const blocker = join(dir, "file");
    writeFileSync(blocker, "x");
    const store = fileSettings(join(blocker, "browse.json")); // the parent is a file, so mkdir fails
    expect(store.update({ confirmQuit: false })).toBe(false);
    expect(store.get().confirmQuit).toBe(false);
  });
});

describe("memorySettings", () => {
  it("applies an initial patch and updates", () => {
    const s = memorySettings({ viewer: { indentTools: true } });
    expect(s.get().viewer).toEqual({ indentReplies: false, indentTools: true });
    s.update({ confirmQuit: false });
    expect(s.get().confirmQuit).toBe(false);
  });
});

describe("date formats", () => {
  // 2026-09-30 is a Wednesday; the clock is noon UTC.
  const NOW = Date.UTC(2026, 8, 30, 12, 0);
  const at = (y: number, mo: number, d: number, h = 0, mi = 0) => Date.UTC(y, mo - 1, d, h, mi);

  it("relative: unchanged from before", () => {
    const f = dateFormat("relative");
    expect(f.format(NOW - 3_600_000, NOW)).toBe("1h ago");
    expect(f.format(NOW - 86_400_000, NOW)).toBe("yesterday");
    expect(f.format(at(2026, 1, 14), NOW)).toBe("Jan 14");
  });

  it("smart: the time today, month + day this year, ISO date before that", () => {
    const f = dateFormat("smart");
    expect(f.format(at(2026, 9, 30, 8, 5), NOW)).toBe("08:05");
    expect(f.format(at(2026, 9, 29, 23, 59), NOW)).toBe("Sep 29");
    expect(f.format(at(2025, 12, 31, 10), NOW)).toBe("2025-12-31");
  });

  it("short, date and date + time", () => {
    const ms = at(2026, 7, 4, 9, 7);
    expect(dateFormat("short").format(ms, NOW)).toBe("Jul 4 09:07");
    expect(dateFormat("date").format(ms, NOW)).toBe("2026-07-04");
    expect(dateFormat("datetime").format(ms, NOW)).toBe("2026-07-04 09:07");
  });

  it("every format fits its declared column width, and unknown ids fall back to relative", () => {
    const samples = [NOW, NOW - 20_000, at(2025, 12, 31, 23, 59), at(2026, 11, 28, 23, 59), at(2026, 9, 30, 0, 0)];
    for (const f of DATE_FORMATS) for (const ms of samples) expect(f.format(ms, NOW).length, `${f.id} ${ms}`).toBeLessThanOrEqual(f.width);
    expect(dateFormat("nope" as never).id).toBe("relative");
  });
});
