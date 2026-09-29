/**
 * Marks where a jump from the rails landed: an outline that pulses around the target,
 * then fades. It is an overlay rather than a style on the entry, so it shows the same
 * over any variant's backgrounds, borders, and pseudo-element decorations, in the
 * variant's --accent.
 */
import { h } from "./el.ts";

/** Space between the target's box and the outline. */
const OUTSET = 5;
/** Start when the target is this close to where the scroll will leave it... */
const LEAD_PX = 120;
/** ...or once scrolling has been quiet this long (the page couldn't scroll that far). */
const SETTLE_MS = 120;

let current: { el: HTMLElement; stop: () => void } | undefined;

/**
 * Beacon on `target`, just scrolled to with `block: "start"`; a turn section lights its
 * first entry (normally the prompt).
 */
export function beacon(target: HTMLElement): void {
  current?.stop();
  const box = target.classList.contains("turn") ? (target.querySelector<HTMLElement>(":scope > .entry") ?? target) : target;
  const host = box.closest<HTMLElement>(".turn");
  if (!host) return;

  const el = h("div", { class: "beacon", "aria-hidden": "true" });
  const place = () => {
    const b = box.getBoundingClientRect();
    const o = host.getBoundingClientRect();
    Object.assign(el.style, {
      left: `${b.left - o.left - OUTSET}px`,
      top: `${b.top - o.top - OUTSET}px`,
      width: `${b.width + OUTSET * 2}px`,
      height: `${b.height + OUTSET * 2}px`,
    });
  };

  // Start as the target arrives rather than after the scroll settles, so the pulse is
  // already under way when it comes to rest.
  const goal = parseFloat(getComputedStyle(target).scrollMarginTop) || 0;
  const near = () => Math.abs(target.getBoundingClientRect().top - goal) < LEAD_PX;
  let timer = 0;
  const start = () => {
    clearTimeout(timer);
    window.removeEventListener("scroll", onScroll);
    host.append(el);
    place();
    el.addEventListener("animationend", (e) => e.animationName === "bc-life" && stop());
  };
  const onScroll = () => {
    clearTimeout(timer);
    if (near()) start();
    else timer = window.setTimeout(start, SETTLE_MS);
  };
  const resize = new ResizeObserver(() => el.isConnected && place());
  resize.observe(host);
  const stop = () => {
    clearTimeout(timer);
    window.removeEventListener("scroll", onScroll);
    resize.disconnect();
    el.remove();
    if (current?.el === el) current = undefined;
  };
  current = { el, stop };
  if (near()) return start();
  window.addEventListener("scroll", onScroll, { passive: true });
  timer = window.setTimeout(start, SETTLE_MS);
}
