/**
 * The loading screen: a log with one line per stage of opening a share (fetching, reading,
 * rendering). The current line has a spinner; finished ones get a ✓ and how long they took, so
 * a slow open shows whether the time went to the network or to laying out a long session.
 *
 * index.html carries the first line ("loading viewer"), so the log shows before this script has
 * loaded. base.css holds the whole log back for 300ms, so a fast open never flashes it.
 */
import { h } from "./el.ts";

export interface BootLog {
  /** The element to show: the log, inside the box that delays it. */
  el: HTMLElement;
  /** Finish the current stage and start the next. */
  step(text: string, detail?: string): void;
  /** Mark the current stage failed and return the log, to show above the error. Undefined if no stage was started. */
  fail(): HTMLElement | undefined;
}

/**
 * A log on `shown` (the one index.html carries, timed from navigation start) or a new empty one,
 * timed from now. `now` is for tests.
 */
export function bootLog(shown?: HTMLElement | null, now = () => performance.now()): BootLog {
  const el = shown ?? h("div", { class: "status loading", role: "status" }, h("ol", { class: "boot" }));
  const list = el.querySelector("ol")!;
  let since = shown ? 0 : now();
  let started = false;

  /** Close the current line with how long it took. */
  const stamp = (cls?: string) => {
    const line = list.lastElementChild;
    if (!line) return;
    if (cls) line.classList.add(cls);
    const t = now();
    line.append(h("span", { class: "t" }, ` ${((t - since) / 1000).toFixed(1)}s`));
    since = t;
  };

  return {
    el,
    step(text, detail) {
      stamp();
      started = true;
      list.append(h("li", {}, h("span", { class: "mark" }), text, detail && h("span", { class: "n" }, ` ${detail}`)));
    },
    fail() {
      if (!started) return undefined;
      stamp("fail");
      return list;
    },
  };
}

/**
 * Resolve after the browser has had a chance to paint, so the last step shows before a long
 * render blocks the main thread. The timeout covers background tabs, which get no frames.
 */
export function nextPaint(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => setTimeout(resolve));
    setTimeout(resolve, 100);
  });
}
