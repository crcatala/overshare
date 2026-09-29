/**
 * Menus that open below a header button (settings, share). A menu is attached to <body>
 * with fixed positioning, because the minibar it can open from is transformed and blurred
 * (either would trap a fixed child), and in one variant clipped.
 */
import { h } from "./el.ts";

/** Close whichever menu is open (e.g. before the page re-renders). */
export function closeMenus(): void {
  for (const m of document.querySelectorAll(".menu")) (m as HTMLElement & { close?: () => void }).close?.() ?? m.remove();
}

export interface MenuContent {
  /** Everything in the menu, in order. */
  children: Node[];
  /** The rows arrow keys move between (disabled ones are skipped). */
  items: HTMLButtonElement[];
  /** The row to focus when the menu opens (default: the first enabled one). */
  focus?: HTMLButtonElement;
}

/** One row: a label with a line of detail under it, and an optional check mark column. */
export function menuItem(label: string, blurb: string, onclick: () => void, opts: { checked?: boolean; disabled?: boolean } = {}): HTMLButtonElement {
  return h(
    "button",
    {
      type: "button",
      class: "menu-item",
      role: opts.checked === undefined ? "menuitem" : "menuitemradio",
      "aria-checked": opts.checked === undefined ? undefined : String(opts.checked),
      disabled: opts.disabled,
      onclick,
    },
    h("span", { class: "menu-check", "aria-hidden": "true" }, opts.checked ? "✓" : ""),
    h("span", { class: "menu-text" }, h("span", { class: "menu-label" }, label), h("span", { class: "menu-blurb" }, blurb)),
  );
}

/** Make `button` open a menu built by `build` each time (so it shows the current state). */
export function menuButton(button: HTMLElement, label: string, build: (close: () => void) => MenuContent): HTMLElement {
  button.setAttribute("aria-haspopup", "menu");
  button.setAttribute("aria-expanded", "false");

  const open = () => {
    closeMenus();
    const listeners = new AbortController();
    function close() {
      listeners.abort();
      menu.remove();
      button.setAttribute("aria-expanded", "false");
    }
    const content = build(close);
    const items = content.items;
    const menu = h("div", { class: "menu", role: "menu", "aria-label": label }, ...content.children);
    Object.assign(menu, { close });
    document.body.append(menu);
    // Below the button, right edges aligned, kept inside the window.
    const r = button.getBoundingClientRect();
    const { width, height } = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(window.innerWidth - width - 8, r.right - width))}px`;
    menu.style.top = `${r.bottom + height + 8 > window.innerHeight ? Math.max(8, r.top - height - 6) : r.bottom + 6}px`;
    button.setAttribute("aria-expanded", "true");
    (content.focus ?? items.find((i) => !i.disabled))?.focus({ preventScroll: true });

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
        const enabled = items.filter((i) => !i.disabled);
        const i = enabled.indexOf(document.activeElement as HTMLButtonElement);
        if (e.key === "Escape") {
          e.stopPropagation();
          close();
          button.focus();
        } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          enabled[(i + (e.key === "ArrowDown" ? 1 : enabled.length - 1)) % enabled.length]?.focus({ preventScroll: true });
        } else if (e.key === "Tab") close();
      },
      { signal },
    );
  };

  button.addEventListener("click", () => (button.getAttribute("aria-expanded") === "true" ? closeMenus() : open()));
  return button;
}
