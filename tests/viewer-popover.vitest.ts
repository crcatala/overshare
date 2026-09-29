// @vitest-environment jsdom
/** Hover cards: open on hover, stay open on the way to the card, close when the pointer goes elsewhere. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { h } from "../viewer/src/el.ts";
import { closeHoverCard, hoverCard } from "../viewer/src/popover.ts";

const rect = (left: number, top: number, right: number, bottom: number): DOMRect => ({ left, top, right, bottom, x: left, y: top, width: right - left, height: bottom - top, toJSON: () => ({}) }) as DOMRect;

function move(x: number, y: number, target: Element = document.body): void {
  const e = new MouseEvent("pointermove", { clientX: x, clientY: y, bubbles: true });
  Object.defineProperty(e, "pointerType", { value: "mouse" });
  target.dispatchEvent(e);
}

function enter(el: Element, x: number, y: number): void {
  const e = new MouseEvent("pointerenter", { clientX: x, clientY: y });
  Object.defineProperty(e, "pointerType", { value: "mouse" });
  el.dispatchEvent(e);
}

describe("hoverCard", () => {
  let trigger: HTMLElement;
  let picked: string[];
  const card = () => document.querySelector<HTMLElement>(".hcard");

  beforeEach(() => {
    vi.useFakeTimers();
    picked = [];
    document.body.replaceChildren();
    Object.defineProperty(window, "innerWidth", { value: 1200, configurable: true });
    Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });
    const rail = h("aside", { class: "rail" });
    trigger = h("div", {});
    rail.append(trigger);
    document.body.append(rail);
    rail.getBoundingClientRect = () => rect(900, 0, 1150, 800);
    trigger.getBoundingClientRect = () => rect(910, 100, 1140, 120);
    hoverCard(trigger, {
      label: "Bash calls",
      beside: () => rail,
      build: (close) =>
        h("div", {}, h("button", { type: "button", "data-hc-item": "", onclick: () => { picked.push("one"); close(); } }, "one"), h("button", { type: "button", "data-hc-item": "" }, "two")),
    });
    // jsdom has no layout: the card is 300x200 wherever it lands.
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this === trigger) return rect(910, 100, 1140, 120);
      if (this.classList.contains("rail")) return rect(900, 0, 1150, 800);
      if (this.classList.contains("hcard")) {
        const left = parseFloat(this.style.left || "0");
        const top = parseFloat(this.style.top || "0");
        return rect(left, top, left + 300, top + 200);
      }
      return rect(0, 0, 0, 0);
    });
  });

  afterEach(() => {
    closeHoverCard();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("opens after a short hover, to the left of the rail, aligned with the trigger", () => {
    enter(trigger, 1000, 110);
    expect(card()).toBeNull();
    vi.advanceTimersByTime(300);
    expect(card()).not.toBeNull();
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(card()!.style.left).toBe("592px"); // rail.left - 8 - 300
    expect(card()!.style.top).toBe("92px");
  });

  it("does not open if the pointer just passes over", () => {
    enter(trigger, 1000, 110);
    trigger.dispatchEvent(new MouseEvent("pointerleave"));
    vi.advanceTimersByTime(1000);
    expect(card()).toBeNull();
  });

  it("stays open on the way to the card and while inside it, then closes shortly after the pointer leaves for elsewhere", () => {
    enter(trigger, 1000, 110);
    vi.advanceTimersByTime(300);
    move(1000, 110);
    move(905, 112); // out of the trigger, across the rail's edge and gap
    vi.advanceTimersByTime(1000);
    expect(card()).not.toBeNull();
    move(880, 150); // in the gap, heading left
    move(800, 150); // inside the card
    vi.advanceTimersByTime(1000);
    expect(card()).not.toBeNull();
    move(300, 600); // far away
    vi.advanceTimersByTime(100);
    expect(card()).not.toBeNull(); // a moment of grace
    vi.advanceTimersByTime(100);
    expect(card()).toBeNull();
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("closes when the pointer heads away from the card", () => {
    enter(trigger, 1000, 110);
    vi.advanceTimersByTime(300);
    move(1000, 110);
    move(1100, 300); // below the row, away from the card
    vi.advanceTimersByTime(200);
    expect(card()).toBeNull();
  });

  it("a pointer that comes back within the grace period keeps it open", () => {
    enter(trigger, 1000, 110);
    vi.advanceTimersByTime(300);
    move(1000, 110);
    move(1100, 300);
    vi.advanceTimersByTime(100);
    move(1000, 110);
    vi.advanceTimersByTime(1000);
    expect(card()).not.toBeNull();
  });

  it("closes on Escape from the card, on an outside press, and after a choice", () => {
    const open = () => {
      enter(trigger, 1000, 110);
      vi.advanceTimersByTime(300);
    };
    open();
    card()!.querySelector("button")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(card()).toBeNull();
    open();
    document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    expect(card()).toBeNull();
    open();
    card()!.querySelector("button")!.click();
    expect(picked).toEqual(["one"]);
    expect(card()).toBeNull();
  });

  it("closes when something moves the trigger, but not when the card's own list scrolls or a fixed rail's page does", () => {
    enter(trigger, 1000, 110);
    vi.advanceTimersByTime(300);
    card()!.querySelector("button")!.dispatchEvent(new Event("scroll"));
    document.dispatchEvent(new Event("scroll"));
    expect(card()).not.toBeNull();
    trigger.getBoundingClientRect = () => rect(910, 60, 1140, 80);
    document.dispatchEvent(new Event("scroll"));
    expect(card()).toBeNull();
  });

  it("keeps the wheel over the card from scrolling the page behind it", () => {
    enter(trigger, 1000, 110);
    vi.advanceTimersByTime(300);
    const wheel = new WheelEvent("wheel", { deltaY: 100, cancelable: true, bubbles: true });
    card()!.dispatchEvent(wheel);
    expect(wheel.defaultPrevented).toBe(true); // nothing to scroll in this list
  });

  it("opens from the keyboard onto its first entry, and arrows move between entries", () => {
    trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    const [one, two] = Array.from(card()!.querySelectorAll("button"));
    expect(document.activeElement).toBe(one);
    one!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(document.activeElement).toBe(two);
    // Keyboard focus in the card keeps it open even if the pointer is elsewhere.
    move(10, 10);
    vi.advanceTimersByTime(1000);
    expect(card()).not.toBeNull();
  });

  it("swaps to another trigger's card quickly", () => {
    const other = h("div", {});
    document.body.append(other);
    hoverCard(other, { label: "Edit calls", build: () => h("div", { class: "second" }, "x") });
    enter(trigger, 1000, 110);
    vi.advanceTimersByTime(300);
    enter(other, 1000, 200);
    vi.advanceTimersByTime(80);
    expect(document.querySelectorAll(".hcard")).toHaveLength(1);
    expect(card()!.querySelector(".second")).not.toBeNull();
  });
});
