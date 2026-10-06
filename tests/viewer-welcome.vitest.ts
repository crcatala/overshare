// @vitest-environment jsdom
/** The start page (no share in the link) and the pasted links it opens. */
import { describe, expect, it, vi } from "vitest";
import { EXAMPLE_SHARE_PATH } from "../src/fixtures/index.ts";

(globalThis as { __OVERSHARE_SOURCES__?: Record<string, string> }).__OVERSHARE_SOURCES__ = {};
const { parseShareLink } = await import("../viewer/src/source.ts");
const { EXAMPLE_HASH, renderWelcome } = await import("../viewer/src/welcome.ts");
const { VARIANTS } = await import("../viewer/src/variants.ts");

const ID = "5260b8cf9b1baae31a40717ac1ab5f08";
const settings = { current: () => VARIANTS[0]!, onPick: () => {}, defaults: () => ({ canSave: false, canReset: false }), saveDefault: () => {}, resetDefault: () => {} };

describe("parseShareLink", () => {
  const source = (input: string) => parseShareLink(input)?.source;

  it("reads gist page and raw URLs, with or without a scheme", () => {
    const raw = { kind: "raw-gist", owner: "octo", id: ID };
    expect(source(`https://gist.github.com/octo/${ID}`)).toEqual(raw);
    expect(source(`  https://gist.github.com/octo/${ID}/  `)).toEqual(raw);
    expect(source(`https://gist.github.com/octo/${ID}#file-session-json`)).toEqual(raw);
    expect(source(`gist.github.com/octo/${ID}`)).toEqual(raw);
    expect(source(`https://gist.githubusercontent.com/octo/${ID}/raw/session.json`)).toEqual(raw);
    expect(source(`https://gist.github.com/${ID}`)).toEqual({ kind: "api-gist", id: ID });
  });

  it("reads a viewer link from any site by its hash, keeping its params", () => {
    const state = parseShareLink(`https://overshare.example/s/#octo/${ID}&turn=3`);
    expect(state?.source).toEqual({ kind: "raw-gist", owner: "octo", id: ID });
    expect(state?.params.get("turn")).toBe("3");
    expect(parseShareLink(`127.0.0.1:4321/s/#octo/${ID}`)?.source).toEqual({ kind: "raw-gist", owner: "octo", id: ID });
  });

  it("reads the part after # on its own", () => {
    expect(source(`octo/${ID}`)).toEqual({ kind: "raw-gist", owner: "octo", id: ID });
    expect(source(`#gist:${ID}`)).toEqual({ kind: "api-gist", id: ID });
    expect(source(ID)).toEqual({ kind: "api-gist", id: ID });
  });

  it("names no share for anything else", () => {
    for (const input of ["", "   ", "hello", "https://example.com/", "https://example.com/s/", "https://gist.github.com/octo", "https://gist.github.com/octo/not-an-id", "gist.github.com/octo"]) {
      expect(parseShareLink(input), input).toBeUndefined();
    }
  });
});

describe("renderWelcome", () => {
  const render = () => {
    const open = vi.fn();
    const toggleTheme = vi.fn();
    const el = renderWelcome({ settings, toggleTheme, open });
    document.body.replaceChildren(el);
    const input = el.querySelector<HTMLInputElement>(".welcome-input")!;
    const submit = (value: string) => {
      input.value = value;
      el.querySelector("form")!.requestSubmit();
    };
    return { el, open, toggleTheme, input, submit };
  };

  it("links the example session the viewer build ships", () => {
    expect(EXAMPLE_HASH).toBe(`#url:${EXAMPLE_SHARE_PATH}`);
    expect(render().el.querySelector(".welcome-example a")?.getAttribute("href")).toBe(EXAMPLE_HASH);
  });

  it("opens a pasted link", () => {
    const { open, submit } = render();
    submit(`https://gist.github.com/octo/${ID}`);
    expect(open).toHaveBeenCalledOnce();
    expect(open.mock.calls[0]![0].source).toEqual({ kind: "raw-gist", owner: "octo", id: ID });
  });

  it("says what's wrong with a link it can't open, until it is edited", () => {
    const { el, open, input, submit } = render();
    const hint = el.querySelector(".welcome-hint")!;
    submit("");
    expect(hint.textContent).toBe("Paste a link first.");
    submit("https://example.com/");
    expect(open).not.toHaveBeenCalled();
    expect(hint.classList.contains("is-error")).toBe(true);
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(input);
    input.dispatchEvent(new Event("input"));
    expect(hint.classList.contains("is-error")).toBe(false);
    expect(input.hasAttribute("aria-invalid")).toBe(false);
  });

  it("has a theme toggle beside settings, the command to share your own, and the footer credit", () => {
    const { el, toggleTheme } = render();
    expect(Array.from(el.querySelectorAll(".hdr-actions > button"), (b) => b.className)).toEqual(["icon theme", "icon settings"]);
    el.querySelector<HTMLButtonElement>("button.theme")!.click();
    expect(toggleTheme).toHaveBeenCalledOnce();
    expect(el.querySelector(".welcome-cmd code")?.textContent).toBe("npx overshare publish --current");
    expect(el.querySelector(".credit")?.textContent).toContain("Created with overshare");
  });
});
