// @vitest-environment jsdom
/** The local sessions page: what each row shows, and that changing variant leaves the page (and focus) alone. */
import { afterEach, describe, expect, it, vi } from "vitest";

(globalThis as { __AGENT_SHARE_SOURCES__?: Record<string, string> }).__AGENT_SHARE_SOURCES__ = {};
const { fetchLocalShares, renderPicker, setPickerVariant } = await import("../viewer/src/picker.ts");
const { variantKeyStep } = await import("../viewer/src/nav.ts");
const { VARIANTS } = await import("../viewer/src/variants.ts");

const shares = [
  { name: "a.json", title: "Fix the bug", harness: "claude-code", mode: "brief", turns: 8, project: "app @ main", startedAt: "2026-03-10T07:02:00Z" },
  { name: "b c.json", harness: "pi", mode: "minimal", turns: 1 },
  { name: "bad.json", error: "Unexpected token" },
];
const options = () => ({ variant: null, settings: { current: () => VARIANTS[0]!, onPick: () => {} }, toggleTheme: vi.fn() });

describe("renderPicker", () => {
  it("shows each share as a link with badges for harness, mode, turns and project", () => {
    const el = renderPicker(shares, options());
    const rows = Array.from(el.querySelectorAll("li"));
    expect(rows.map((r) => r.querySelector("a")?.textContent)).toEqual(["Fix the bug", "b c.json", "bad.json"]);
    expect(Array.from(rows[0]!.querySelectorAll(".badge"), (b) => b.textContent)).toEqual(["Claude Code", "brief", "8 turns", "app @ main"]);
    expect(rows[0]!.querySelector<HTMLElement>(".badge[data-mode]")?.dataset.mode).toBe("brief");
    expect(rows[0]!.querySelector(".picker-file")?.textContent).toBe("a.json");
    expect(rows[0]!.querySelector(".picker-date")).not.toBeNull();
    expect(Array.from(rows[1]!.querySelectorAll(".badge"), (b) => b.textContent)).toEqual(["pi", "minimal", "1 turn"]);
    const bad = rows[2]!.querySelector<HTMLElement>(".badge.is-error")!;
    expect(bad.textContent).toBe("unreadable");
    expect(bad.title).toBe("Unexpected token");
  });

  it("has a theme toggle beside settings, and the footer credit", () => {
    const opts = options();
    const el = renderPicker(shares, opts);
    const actions = Array.from(el.querySelectorAll(".hdr-actions > button"), (b) => b.className);
    expect(actions).toEqual(["icon theme", "icon settings"]);
    el.querySelector<HTMLButtonElement>("button.theme")!.click();
    expect(opts.toggleTheme).toHaveBeenCalledOnce();
    expect(el.querySelector(".credit")?.textContent).toContain("Created with agent-share");
  });

  it("links to each share, carrying the variant and encoding names", () => {
    const links = (variant: string | null) => Array.from(renderPicker(shares, { ...options(), variant }).querySelectorAll("a[data-share]"), (a) => a.getAttribute("href"));
    expect(links(null)).toEqual(["#local:a.json", "#local:b%20c.json", "#local:bad.json"]);
    expect(links("log")[1]).toBe("#local:b%20c.json&variant=log");
  });
});

describe("setPickerVariant", () => {
  it("re-points the links in place, keeping the same elements and keyboard focus", () => {
    const el = renderPicker(shares, options());
    document.body.replaceChildren(el);
    const link = el.querySelector<HTMLAnchorElement>("a[data-share]")!;
    link.focus();
    expect(setPickerVariant(document.body, "timeline")).toBe(true);
    expect(document.activeElement).toBe(link);
    expect(el.querySelector("a[data-share]")).toBe(link);
    expect(link.getAttribute("href")).toBe("#local:a.json&variant=timeline");
  });

  it("says when the picker isn't showing", () => {
    document.body.replaceChildren(document.createElement("div"));
    expect(setPickerVariant(document.body, "log")).toBe(false);
  });
});

describe("fetchLocalShares", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns the index, or undefined when there is none", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(shares))));
    expect(await fetchLocalShares()).toHaveLength(3);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 404 })));
    expect(await fetchLocalShares()).toBeUndefined();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("[]")));
    expect(await fetchLocalShares()).toBeUndefined();
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("offline"))));
    expect(await fetchLocalShares()).toBeUndefined();
  });
});

describe("variantKeyStep", () => {
  const key = (init: KeyboardEventInit, target?: Element) => {
    const e = new KeyboardEvent("keydown", { bubbles: true, ...init });
    if (target) Object.defineProperty(e, "target", { value: target });
    return variantKeyStep(e);
  };

  it("v goes forward and V back, and nothing else does", () => {
    expect(key({ key: "v" })).toBe(1);
    expect(key({ key: "V" })).toBe(-1);
    expect(key({ key: "x" })).toBeUndefined();
  });

  it("stays out of the way of modifiers and text fields", () => {
    expect(key({ key: "v", ctrlKey: true })).toBeUndefined();
    expect(key({ key: "v", metaKey: true })).toBeUndefined();
    expect(key({ key: "v" }, document.createElement("input"))).toBeUndefined();
    expect(key({ key: "V" }, document.createElement("textarea"))).toBeUndefined();
  });
});
