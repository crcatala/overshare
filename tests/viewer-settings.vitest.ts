// @vitest-environment jsdom
/** View settings: the `&ui=` tokens, where each field comes from, and the settings and share menus. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { __AGENT_SHARE_SOURCES__?: Record<string, string> }).__AGENT_SHARE_SOURCES__ = {};
const vs = await import("../viewer/src/viewsettings.ts");
const { settingsButton } = await import("../viewer/src/settings.ts");
const { shareButton, shareLink } = await import("../viewer/src/share.ts");
const { closeMenus } = await import("../viewer/src/menu.ts");
const { VARIANTS } = await import("../viewer/src/variants.ts");

const { BUILT_IN, defaultsState, parseUi, formatUi, resolve, viewFor, wantedView } = vs;
type ViewSettings = import("../viewer/src/viewsettings.ts").ViewSettings;

describe("&ui= tokens", () => {
  it("round-trips every field", () => {
    const s: ViewSettings = { variant: "log", view: "brief", theme: "dark", left: true, right: false, toc: "all" };
    expect(formatUi(s)).toBe("log.brief.dark.L.toc-all");
    expect(parseUi(formatUi(s))).toEqual(s);
    expect(formatUi(BUILT_IN)).toBe("classic.full.system.LR.toc-prompts");
  });

  it("encodes each combination of open rails", () => {
    for (const [left, right, token] of [[true, true, "LR"], [true, false, "L"], [false, true, "R"], [false, false, "-"]] as const) {
      expect(formatUi({ ...BUILT_IN, left, right }).split(".")[3]).toBe(token);
      expect(parseUi(token)).toEqual({ left, right });
    }
  });

  it("reads tokens in any order and only the fields given", () => {
    expect(parseUi("dark.timeline")).toEqual({ theme: "dark", variant: "timeline" });
    expect(parseUi("minimal")).toEqual({ view: "minimal" });
    expect(parseUi("prompts.toc-all")).toEqual({ view: "prompts", toc: "all" });
    expect(parseUi("toc-prompts")).toEqual({ toc: "prompts" });
  });

  // A renamed or removed option (or a typo) drops only that field back to the reader's own setting.
  it("skips tokens it doesn't know", () => {
    expect(parseUi("retro.brief.sepia.LRX.toc-some.constructor.__proto__")).toEqual({ view: "brief" });
    expect(parseUi("")).toEqual({});
    expect(parseUi(null)).toEqual({});
  });

  it("uses only URL-safe characters", () => {
    const s: ViewSettings = { ...BUILT_IN, left: false, right: false };
    expect(new URLSearchParams({ ui: formatUi(s) }).toString()).toBe(`ui=${formatUi(s)}`);
  });
});

describe("resolve", () => {
  it("takes each field from the link, then this tab, then the saved default, then built-in", () => {
    const s = resolve({ variant: "log" }, { variant: "cli", theme: "light" }, { variant: "hybrid", theme: "dark", view: "brief" });
    expect(s).toEqual({ ...BUILT_IN, variant: "log", theme: "light", view: "brief" });
  });

  it("falls back to built-in with nothing else", () => {
    expect(resolve({}, {}, {})).toEqual(BUILT_IN);
  });
});

describe("viewFor", () => {
  it("shows the view wanted when the share has it, else the most it was published with", () => {
    expect(viewFor("brief", "full")).toBe("brief");
    expect(viewFor("full", "brief")).toBe("brief");
    expect(viewFor("brief", "minimal")).toBe("minimal");
    expect(viewFor("minimal", "brief")).toBe("minimal");
    expect(viewFor("prompts", "full")).toBe("prompts");
    expect(viewFor("full", "prompts")).toBe("prompts");
    expect(viewFor("prompts", "full", false)).toBe("full");
    expect(viewFor("prompts", "brief", false)).toBe("brief");
  });
});

describe("wantedView", () => {
  // The share-with-view link and the mode switch both keep this, so a brief-only share
  // never turns the reader's tab or saved default into brief.
  it("keeps the most a share has as full, and anything less as itself", () => {
    expect(wantedView("brief", "brief")).toBe("full");
    expect(wantedView("minimal", "minimal")).toBe("full");
    expect(wantedView("full", "full")).toBe("full");
    expect(wantedView("minimal", "brief")).toBe("minimal");
    expect(wantedView("brief", "full")).toBe("brief");
    expect(wantedView("prompts", "full")).toBe("prompts");
    expect(wantedView("prompts", "prompts")).toBe("full");
  });
});

describe("defaultsState", () => {
  const cli: ViewSettings = { ...BUILT_IN, variant: "cli" };

  it("with nothing saved: can save anything but built-in, and reset back to it", () => {
    expect(defaultsState(BUILT_IN, undefined)).toEqual({ saved: undefined, canSave: false, canReset: false });
    expect(defaultsState(cli, undefined)).toEqual({ saved: undefined, canSave: true, canReset: true });
  });

  it("with a default saved: describes it, offers saving anything else, and always offers reset", () => {
    expect(defaultsState(cli, cli)).toEqual({ saved: "cli · full · system theme · both rails", canSave: false, canReset: true });
    expect(defaultsState(BUILT_IN, cli)).toMatchObject({ canSave: true, canReset: true });
  });

  it("compares against the saved default filled out with built-in values", () => {
    expect(defaultsState(cli, { variant: "cli" }).canSave).toBe(false);
  });
});

describe("storage", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it("has no saved default until one is saved, and forgets it on reset", () => {
    expect(vs.loadSaved()).toBeUndefined();
    const s: ViewSettings = { ...BUILT_IN, variant: "cli", theme: "dark" };
    vs.saveDefault(s);
    expect(vs.loadSaved()).toEqual(s);
    vs.saveDefault(null);
    expect(vs.loadSaved()).toBeUndefined();
  });

  it("keeps this tab's settings in sessionStorage", () => {
    expect(vs.loadTab()).toEqual({});
    const s: ViewSettings = { ...BUILT_IN, view: "minimal" };
    vs.saveTab(s);
    expect(vs.loadTab()).toEqual(s);
    expect(localStorage.length).toBe(0);
  });

  it("reads a damaged value as far as it can", () => {
    localStorage.setItem("agent-share-default-view", "log.???");
    expect(vs.loadSaved()).toEqual({ variant: "log" });
  });

  it("carries on without storage", () => {
    const denied = () => {
      throw new DOMException("denied", "SecurityError");
    };
    const spy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(denied);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(denied);
    expect(vs.loadSaved()).toBeUndefined();
    expect(vs.loadTab()).toEqual({});
    expect(() => vs.saveTab(BUILT_IN)).not.toThrow();
    expect(spy).toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});

const menuRows = () => Array.from(document.querySelectorAll<HTMLButtonElement>(".menu .menu-item"));
const label = (b: HTMLButtonElement) => b.querySelector(".menu-label")?.textContent;
const blurb = (b: HTMLButtonElement) => b.querySelector(".menu-blurb")?.textContent;

afterEach(() => {
  closeMenus();
  document.body.replaceChildren();
});

describe("settings menu", () => {
  const options = (state: { saved?: string; canSave: boolean; canReset: boolean }) => ({
    current: () => VARIANTS[1]!,
    onPick: vi.fn(),
    defaults: () => state,
    saveDefault: vi.fn(),
    resetDefault: vi.fn(),
  });

  function open(opts: ReturnType<typeof options>) {
    const button = settingsButton(opts);
    document.body.append(button);
    button.click();
    return button;
  }

  it("lists the variants, then saving and resetting the default", () => {
    open(options({ canSave: true, canReset: true }));
    const rows = menuRows();
    expect(rows.map(label)).toEqual([...VARIANTS.map((v) => v.label), "Save as my default", "Reset to built-in default"]);
    expect(rows.filter((r) => r.getAttribute("aria-checked") === "true").map(label)).toEqual([VARIANTS[1]!.label]);
    expect(document.activeElement).toBe(rows[1]);
  });

  it("saves or resets, and closes", () => {
    const opts = options({ saved: "log · brief", canSave: true, canReset: true });
    open(opts);
    menuRows().find((r) => label(r) === "Save as my default")!.click();
    expect(opts.saveDefault).toHaveBeenCalledOnce();
    expect(document.querySelector(".menu")).toBeNull();
    open(opts);
    const reset = menuRows().find((r) => label(r) === "Reset to built-in default")!;
    expect(blurb(reset)).toBe("Forget your default (log · brief)");
    reset.click();
    expect(opts.resetDefault).toHaveBeenCalledOnce();
  });

  it("disables saving when this is already the default, and resetting when there's nothing to reset", () => {
    open(options({ canSave: false, canReset: false }));
    const [save, reset] = menuRows().slice(-2) as [HTMLButtonElement, HTMLButtonElement];
    expect(save.disabled).toBe(true);
    expect(blurb(save)).toBe("This is your default view");
    expect(reset.disabled).toBe(true);
  });

  it("skips disabled rows with the arrow keys", () => {
    open(options({ canSave: false, canReset: true }));
    const rows = menuRows();
    rows[VARIANTS.length - 1]!.focus();
    document.querySelector(".menu")!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(label(document.activeElement as HTMLButtonElement)).toBe("Reset to built-in default");
  });
});

describe("share menu", () => {
  // index.html has the toast's live region from the start.
  beforeEach(() => document.body.append(Object.assign(document.createElement("div"), { id: "toast" })));
  const BASE = "https://view.example/session/?x=1#old";
  const source = { kind: "raw-gist" as const, owner: "someone", id: "0123456789abcdef0123" };

  it("builds links from the source, never the address bar", () => {
    expect(shareLink(source, {}, BASE)).toBe("https://view.example/session/?x=1#someone/0123456789abcdef0123");
    expect(shareLink(source, { ui: "log.brief.dark.L.toc-all" }, BASE)).toBe("https://view.example/session/?x=1#someone/0123456789abcdef0123&ui=log.brief.dark.L.toc-all");
    expect(shareLink(source, { turn: "4" }, BASE)).toBe("https://view.example/session/?x=1#someone/0123456789abcdef0123&turn=4");
  });

  function open(turn?: { ordinal: number; label: string }, src: Parameters<typeof shareLink>[0] = source) {
    const button = shareButton({ source: src, view: () => ({ ui: "log.brief.dark.L.toc-prompts", label: "log · brief · dark · contents rail" }), turn: () => turn });
    document.body.append(button);
    button.click();
  }

  it("offers plain and current-view links, to the session and to the prompt in view", async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    open({ ordinal: 3, label: "Fix the flaky test" });
    const rows = menuRows();
    expect(rows.map(label)).toEqual(["Copy link", "Copy link with current view", "Copy link to prompt 3", "Copy link to prompt 3 with current view"]);
    expect(blurb(rows[1]!)).toBe("log · brief · dark · contents rail");
    expect(blurb(rows[2]!)).toBe("Fix the flaky test");
    expect(blurb(rows[3]!)).toBe("log · brief · dark · contents rail");
    rows[1]!.click();
    expect(document.querySelector(".menu")).toBeNull();
    expect(writeText).toHaveBeenLastCalledWith(expect.stringMatching(/#someone\/0123456789abcdef0123&ui=log\.brief\.dark\.L\.toc-prompts$/));
    await vi.waitFor(() => expect(document.getElementById("toast")?.textContent).toBe("Copied link with current view"));
    const copy = (row: number) => {
      document.querySelector<HTMLButtonElement>("button.share")!.click();
      menuRows()[row]!.click();
      return writeText.mock.lastCall?.[0];
    };
    expect(copy(0)).toMatch(/#someone\/0123456789abcdef0123$/);
    expect(copy(2)).toMatch(/#someone\/0123456789abcdef0123&turn=3$/);
    expect(copy(3)).toMatch(/#someone\/0123456789abcdef0123&ui=log\.brief\.dark\.L\.toc-prompts&turn=3$/);
    await vi.waitFor(() => expect(document.getElementById("toast")?.textContent).toBe("Copied link to prompt 3 with current view"));
    vi.unstubAllGlobals();
  });

  it("can't link to a prompt before one is in view", () => {
    open(undefined);
    const [plain, withView] = menuRows().slice(2);
    for (const row of [plain!, withView!]) {
      expect(row.disabled).toBe(true);
      expect(blurb(row)).toBe("Scroll to a prompt first");
    }
    expect(label(withView!)).toBe("Copy link to this prompt with current view");
  });

  it("warns that local links only work on this machine", () => {
    open(undefined, { kind: "local", name: "a.json" });
    expect(document.querySelector(".menu-foot")?.textContent).toContain("only open on this machine");
    closeMenus();
    open(undefined);
    expect(document.querySelector(".menu-foot")).toBeNull();
  });
});
