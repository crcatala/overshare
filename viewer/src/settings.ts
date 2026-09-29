/**
 * The settings button (two sliders) and its menu: pick a design variant, and save the
 * current view settings as the reader's default (or go back to the built-in one).
 */
import { h, svg } from "./el.ts";
import { menuButton, menuItem } from "./menu.ts";
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

export interface DefaultsState {
  /** The saved default in words, or undefined when there is none. */
  saved?: string;
  /** What's showing differs from the default in effect (saved, or built-in). */
  canSave: boolean;
  /** There is a saved default, or what's showing differs from the built-in one. */
  canReset: boolean;
}

export interface SettingsOptions {
  current: () => Variant;
  onPick: (v: Variant) => void;
  defaults: () => DefaultsState;
  saveDefault: () => void;
  resetDefault: () => void;
}

export { closeMenus } from "./menu.ts";

export function settingsButton(opts: SettingsOptions): HTMLElement {
  const button = h("button", { type: "button", class: "icon settings", "aria-label": "Settings", title: "Settings" });
  button.append(slidersIcon());
  return menuButton(button, "Settings", (close) => {
    const current = opts.current();
    const pick = (fn: () => void) => () => {
      close();
      fn();
    };
    const variants = VARIANTS.map((v) => menuItem(v.label, v.blurb, pick(() => opts.onPick(v)), { checked: v.id === current.id }));
    const d = opts.defaults();
    const save = menuItem("Save as my default", d.canSave ? "Variant, view, theme and open rails, for every session you open" : "This is your default view", pick(opts.saveDefault), { disabled: !d.canSave });
    const resetBlurb = d.saved ? `Forget your default (${d.saved})` : d.canReset ? "Go back to the viewer's own settings" : "Showing the viewer's own settings";
    const reset = menuItem("Reset to built-in default", resetBlurb, pick(opts.resetDefault), { disabled: !d.canReset });
    const items = [...variants, save, reset];
    return {
      children: [
        h("div", { class: "menu-head" }, "Design variant"),
        ...variants,
        h("div", { class: "menu-head menu-section" }, "Default view"),
        save,
        reset,
        h("div", { class: "menu-foot" }, h("kbd", {}, "v"), " next · ", h("kbd", {}, "V"), " previous"),
      ],
      items,
      focus: variants.find((i) => i.getAttribute("aria-checked") === "true"),
    };
  });
}
