/**
 * The settings button (two sliders) and its menu: pick a design variant. The menu is
 * attached to <body> with fixed positioning, because the minibar it can open from is
 * transformed and blurred (either would trap a fixed child), and in one variant clipped.
 */
import { h, svg } from "./el.ts";
import { VARIANTS, type Variant } from "./variants.ts";

/** Two horizontal sliders with their knobs: "adjust how this looks". */
export function slidersIcon(): SVGElement {
  const icon = svg("svg", { viewBox: "0 0 16 16", width: "14", height: "14", fill: "none", stroke: "currentColor", "stroke-width": "1.5", "stroke-linecap": "round", "aria-hidden": "true" });
  icon.append(
    svg("path", { d: "M2 4.5h6.5M12.5 4.5H14M2 11.5h1.5M7.5 11.5H14" }),
    svg("circle", { cx: "10.5", cy: "4.5", r: "2" }),
    svg("circle", { cx: "5.5", cy: "11.5", r: "2" }),
  );
  return icon;
}

export interface SettingsOptions {
  current: () => Variant;
  onPick: (v: Variant) => void;
}

/** Close whichever settings menu is open (e.g. before the page re-renders). */
export function closeMenus(): void {
  for (const m of document.querySelectorAll(".menu")) (m as HTMLElement & { close?: () => void }).close?.() ?? m.remove();
}

export function settingsButton(opts: SettingsOptions): HTMLElement {
  const button = h("button", { type: "button", class: "icon settings", "aria-label": "Settings", title: "Settings", "aria-haspopup": "menu", "aria-expanded": "false" });
  button.append(slidersIcon());

  const open = () => {
    closeMenus();
    const current = opts.current();
    const items = VARIANTS.map((v) =>
      h(
        "button",
        {
          type: "button",
          class: "menu-item",
          role: "menuitemradio",
          "aria-checked": String(v.id === current.id),
          onclick: () => {
            close();
            opts.onPick(v);
          },
        },
        h("span", { class: "menu-check", "aria-hidden": "true" }, v.id === current.id ? "✓" : ""),
        h("span", { class: "menu-text" }, h("span", { class: "menu-label" }, v.label), h("span", { class: "menu-blurb" }, v.blurb)),
      ),
    );
    const menu = h(
      "div",
      { class: "menu", role: "menu", "aria-label": "Design variant" },
      h("div", { class: "menu-head" }, "Design variant"),
      ...items,
      h("div", { class: "menu-foot" }, h("kbd", {}, "v"), " next · ", h("kbd", {}, "V"), " previous"),
    );
    const listeners = new AbortController();
    function close() {
      listeners.abort();
      menu.remove();
      button.setAttribute("aria-expanded", "false");
    }
    Object.assign(menu, { close });
    document.body.append(menu);
    // Below the button, right edges aligned, kept inside the window.
    const r = button.getBoundingClientRect();
    const { width, height } = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(window.innerWidth - width - 8, r.right - width))}px`;
    menu.style.top = `${r.bottom + height + 8 > window.innerHeight ? Math.max(8, r.top - height - 6) : r.bottom + 6}px`;
    button.setAttribute("aria-expanded", "true");
    (items.find((i) => i.getAttribute("aria-checked") === "true") ?? items[0])?.focus({ preventScroll: true });

    const signal = listeners.signal;
    document.addEventListener(
      "pointerdown",
      (e) => {
        const t = e.target as Node;
        if (!menu.contains(t) && !button.contains(t)) close();
      },
      { signal },
    );
    window.addEventListener("scroll", close, { passive: true, signal });
    window.addEventListener("resize", close, { signal });
    menu.addEventListener(
      "keydown",
      (e) => {
        const i = items.indexOf(document.activeElement as HTMLButtonElement);
        if (e.key === "Escape") {
          e.stopPropagation();
          close();
          button.focus();
        } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          items[(i + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus({ preventScroll: true });
        } else if (e.key === "Tab") close();
      },
      { signal },
    );
  };

  button.addEventListener("click", () => (button.getAttribute("aria-expanded") === "true" ? closeMenus() : open()));
  return button;
}
