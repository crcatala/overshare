// @vitest-environment jsdom
/** What the viewer page (main.ts) shows when its link names no share: the start page, or an error for a broken link. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { __OVERSHARE_SOURCES__?: Record<string, string> }).__OVERSHARE_SOURCES__ = {};

/** Load the page at `hash`, with no local shares to pick, and wait for main() to settle. */
async function boot(hash: string): Promise<HTMLElement> {
  vi.resetModules();
  history.replaceState(null, "", `/s/${hash}`);
  document.body.innerHTML = '<main id="app"></main><div id="tooltip" hidden></div><div id="toast"></div>';
  await import("../viewer/src/main.ts");
  const app = document.getElementById("app")!;
  await vi.waitFor(() => expect(app.querySelector(".welcome, .status.error")).not.toBeNull());
  return app;
}

describe("viewer page without a share", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not found", { status: 404 })));
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} }));
  });
  afterEach(() => vi.unstubAllGlobals());

  it("shows the start page for an empty link, with or without view settings", async () => {
    expect((await boot("")).querySelector(".welcome")).not.toBeNull();
    expect((await boot("#&ui=dark")).querySelector(".welcome")).not.toBeNull();
  });

  it("keeps a broken link an error, even when it carries view settings or a prompt", async () => {
    for (const hash of ["#not-a-share", "#not-a-share&ui=dark&turn=3", "#%zz"]) {
      const app = await boot(hash);
      expect(app.querySelector(".status.error p")?.textContent, hash).toBe(`"${hash.split("&")[0]}" doesn't name a session.`);
      expect(location.hash, hash).toBe(hash);
    }
  });
});
