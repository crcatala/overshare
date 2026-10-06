/**
 * Hover cards: a popover that opens beside a trigger when it is hovered (or focused, or
 * tapped) and stays open as long as the pointer is heading for it or in it, so it can be
 * reached, scrolled and clicked. See geometry.ts for how "heading for it" is decided. One
 * card is open at a time; moving to another trigger swaps it in quickly.
 *
 * The card is attached to <body> with fixed positioning, like the settings menu, because
 * the rails are transformed in some states.
 */
import { h } from "./el.ts";
import { SafeZone, type Point } from "./geometry.ts";

/** Hover this long before the card opens (so sweeping across a rail doesn't flash cards)... */
const OPEN_DELAY = 280;
/** ...or this long when a card was just open. */
const WARM_DELAY = 60;
const WARM_WINDOW = 400;
/** After the pointer leaves every safe zone, wait this long (it may come straight back). */
const CLOSE_DELAY = 160;
/** On the way to an open card, another trigger the pointer crosses takes over only once it rests there this long. */
const REST_DELAY = 120;
const GAP = 8;
const MAX_HEIGHT = 360;

export interface HoverCardOptions {
  /** Accessible name of the card. */
  label: string;
  /** Builds the card's contents when it opens. `close` dismisses the card (e.g. after a choice). */
  build: (close: () => void) => HTMLElement;
  /** Open to the left of this (default: the trigger), e.g. the rail the trigger sits in. */
  beside?: () => Element;
  /** Tallest the card may be (default 360px); its list scrolls beyond that. */
  maxHeight?: number;
  /** Called when the card opens, and with false when it closes (e.g. to mark what it is about). */
  onToggle?: (open: boolean) => void;
}

interface OpenCard {
  trigger: HTMLElement;
  card: HTMLElement;
  close: () => void;
  keepOpen: () => void;
  /** The pointer is between the trigger and the card, heading for the card. */
  inTransit: () => boolean;
}

let open: OpenCard | undefined;
let closedAt = 0;

export function closeHoverCard(): void {
  open?.close();
}

export function hoverCard(trigger: HTMLElement, opts: HoverCardOptions): void {
  trigger.tabIndex = 0;
  trigger.setAttribute("aria-haspopup", "true");
  trigger.setAttribute("aria-expanded", "false");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pointer: Point = { x: 0, y: 0 };
  let movedAt = 0;
  let touch = false;

  const show = (focus = false) => {
    if (open?.trigger === trigger) return;
    open = openCard(trigger, opts, pointer, focus);
  };
  // Triggers side by side (a chart's bars) lie across the way to an open card: one passed over doesn't take it.
  const showOnRest = () => {
    const still = performance.now() - movedAt;
    if (open && open.trigger !== trigger && open.inTransit() && still < REST_DELAY) timer = setTimeout(showOnRest, REST_DELAY - still);
    else show();
  };

  trigger.addEventListener("pointerdown", (e) => (touch = e.pointerType === "touch"));
  trigger.addEventListener("pointerenter", (e) => {
    if (e.pointerType === "touch") return;
    pointer = { x: e.clientX, y: e.clientY };
    movedAt = performance.now();
    if (open?.trigger === trigger) return open.keepOpen();
    clearTimeout(timer);
    timer = setTimeout(showOnRest, open || performance.now() - closedAt < WARM_WINDOW ? WARM_DELAY : OPEN_DELAY);
  });
  trigger.addEventListener("pointermove", (e) => {
    pointer = { x: e.clientX, y: e.clientY };
    movedAt = performance.now();
  });
  trigger.addEventListener("pointerleave", () => clearTimeout(timer));
  trigger.addEventListener("click", () => {
    clearTimeout(timer);
    // Hovering already opened it for a mouse; a tap opens it and a second tap closes it.
    if (open?.trigger === trigger) {
      if (touch) open.close();
    } else show();
  });
  trigger.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " " || e.key === "ArrowLeft") {
      e.preventDefault();
      show(true);
    }
  });
}

function openCard(trigger: HTMLElement, opts: HoverCardOptions, pointer: Point, focus: boolean): OpenCard {
  closeHoverCard();
  const listeners = new AbortController();
  const { signal } = listeners;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  const close = () => {
    clearTimeout(closeTimer);
    listeners.abort();
    card.remove();
    trigger.setAttribute("aria-expanded", "false");
    if (open === self) open = undefined;
    closedAt = performance.now();
    opts.onToggle?.(false);
  };
  const card = h("div", { class: "hcard", role: "dialog", "aria-label": opts.label }, opts.build(close));
  document.body.append(card);
  trigger.setAttribute("aria-expanded", "true");
  place(card, trigger, opts.beside?.() ?? trigger, opts.maxHeight ?? MAX_HEIGHT);

  const cancelClose = () => {
    clearTimeout(closeTimer);
    closeTimer = undefined;
  };
  const zone = new SafeZone(
    () => trigger.getBoundingClientRect(),
    () => card.getBoundingClientRect(),
    pointer,
  );
  // Focus in the card holds it open for the keyboard, not after a click (a tab picked with the mouse).
  let clicked = false;
  card.addEventListener("pointerdown", () => (clicked = true), { signal });
  card.addEventListener("keydown", () => (clicked = false), { signal, capture: true });
  const settle = (stay: boolean) => {
    if (stay || (!clicked && card.contains(document.activeElement))) return cancelClose();
    closeTimer ??= setTimeout(close, CLOSE_DELAY);
  };
  document.addEventListener("pointermove", (e) => e.pointerType !== "touch" && settle(zone.move({ x: e.clientX, y: e.clientY })), { signal });
  // Leaving the window sends no more moves.
  document.documentElement.addEventListener("pointerleave", () => settle(false), { signal });
  // Anything that moves the trigger from under the card (the page itself may not: rails are fixed).
  const anchor = trigger.getBoundingClientRect();
  window.addEventListener(
    "scroll",
    (e) => {
      if (card.contains(e.target as Node)) return;
      const now = trigger.getBoundingClientRect();
      if (now.top !== anchor.top || now.left !== anchor.left) close();
    },
    { capture: true, passive: true, signal },
  );
  // Wheeling over the card scrolls its list and stops there; it never carries on to the page behind.
  card.addEventListener(
    "wheel",
    (e) => {
      const list = card.querySelector<HTMLElement>(".hc-list");
      const room = list ? (e.deltaY < 0 ? list.scrollTop > 0 : list.scrollTop + list.clientHeight < list.scrollHeight - 1) : false;
      if (!room) e.preventDefault();
    },
    { passive: false, signal },
  );
  window.addEventListener("resize", close, { signal });
  document.addEventListener(
    "pointerdown",
    (e) => {
      const t = e.target as Node;
      if (!card.contains(t) && !trigger.contains(t)) close();
    },
    { signal },
  );
  card.addEventListener("keydown", (e) => {
    const items = Array.from(card.querySelectorAll<HTMLElement>("[data-hc-item]"));
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
      trigger.focus({ preventScroll: true });
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Home" || e.key === "End") {
      e.preventDefault();
      const to = e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 : (i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      items[to]?.focus({ preventScroll: false });
    } else if (e.key === "Tab") close();
  });
  trigger.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "Escape") close();
    },
    { signal },
  );
  if (focus) card.querySelector<HTMLElement>("[data-hc-item]")?.focus();
  opts.onToggle?.(true);

  const self: OpenCard = { trigger, card, close, keepOpen: cancelClose, inTransit: () => zone.inTransit };
  return self;
}

/** Beside `edge` (left of it, else right of it), top-aligned with the trigger; below the trigger when there's no room. */
function place(card: HTMLElement, trigger: HTMLElement, edge: Element, maxHeight: number): void {
  card.style.maxHeight = `${Math.min(maxHeight, window.innerHeight - 16)}px`;
  const { width, height } = card.getBoundingClientRect();
  const t = trigger.getBoundingClientRect();
  const b = edge.getBoundingClientRect();
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
  let left: number;
  let top: number;
  if (b.left - GAP - width >= 8) {
    left = b.left - GAP - width;
    top = t.top - 8;
  } else if (b.right + GAP + width <= window.innerWidth - 8) {
    left = b.right + GAP;
    top = t.top - 8;
  } else {
    left = t.left;
    top = t.bottom + 4 + height > window.innerHeight - 8 ? t.top - height - 4 : t.bottom + 4;
  }
  card.style.left = `${clamp(left, 8, window.innerWidth - width - 8)}px`;
  card.style.top = `${clamp(top, 8, window.innerHeight - height - 8)}px`;
}
