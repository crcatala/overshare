// @vitest-environment jsdom
/** The loading log: one line per stage of opening a share, each finished one ticked with its time. */
import { describe, expect, it } from "vitest";

const { bootLog } = await import("../viewer/src/boot.ts");

/** A clock the test moves by hand. */
function clock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

const lines = (el: HTMLElement) => Array.from(el.querySelectorAll("li"), (li) => li.textContent);

describe("bootLog", () => {
  it("ticks each stage with how long it took when the next one starts", () => {
    const c = clock(1000);
    const log = bootLog(undefined, c.now);
    log.step("fetching", "gist.githubusercontent.com");
    c.advance(1250);
    log.step("reading", "overshare/3 · 4.8 MB");
    c.advance(40);
    log.step("rendering 1508 turns");
    expect(lines(log.el)).toEqual(["fetching gist.githubusercontent.com 1.3s", "reading overshare/3 · 4.8 MB 0.0s", "rendering 1508 turns"]);
  });

  it("continues the line index.html shows, timed from navigation start", () => {
    const shown = document.createElement("div");
    shown.innerHTML = '<ol class="boot"><li><span class="mark"></span>loading viewer</li></ol>';
    const log = bootLog(shown, clock(420).now);
    log.step("fetching", "api.github.com");
    expect(log.el).toBe(shown);
    expect(lines(shown)).toEqual(["loading viewer 0.4s", "fetching api.github.com"]);
  });

  it("marks the stage that failed and returns the log to show with the error", () => {
    const c = clock();
    const log = bootLog(undefined, c.now);
    log.step("fetching", "gist.githubusercontent.com");
    c.advance(800);
    const failed = log.fail();
    expect(failed?.tagName).toBe("OL");
    expect(failed?.lastElementChild?.classList.contains("fail")).toBe(true);
    expect(lines(log.el)).toEqual(["fetching gist.githubusercontent.com 0.8s"]);
  });

  it("returns nothing to show when it failed before any stage started", () => {
    expect(bootLog(undefined, clock().now).fail()).toBeUndefined();
  });
});
