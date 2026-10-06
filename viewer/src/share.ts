/**
 * The share button and its menu: copy a link to the session as-is (the reader sees it
 * their own way) or with the view settings on screen (`&ui=`), either one optionally at
 * the prompt in view (`&turn=`). Links are built from the share's source, never from the
 * address bar.
 */
import { h, svg } from "./el.ts";
import { toast } from "./dom.ts";
import { menuButton, menuItem } from "./menu.ts";
import { formatHash, type Source } from "./source.ts";

/** A tray with an arrow leaving it: "send this somewhere". */
function shareIcon(): SVGElement {
  const icon = svg("svg", { viewBox: "0 0 16 16", width: "14", height: "14", fill: "none", stroke: "currentColor", "stroke-width": "1.5", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" });
  icon.append(svg("path", { d: "M8 10V2M5 4.5 8 1.5l3 3" }), svg("path", { d: "M3.5 7.5v5.5a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V7.5" }));
  return icon;
}

/** The viewer link for a share, with extra hash params (the view settings, a turn). */
export function shareLink(source: Source, params: Record<string, string> = {}, base = location.href): string {
  return new URL(formatHash({ source, params: new URLSearchParams(params) }), base).href;
}

export interface ShareOptions {
  source: Source;
  /** The view settings on screen, as a `&ui=` value and in words. */
  view: () => { ui: string; label: string };
  /** The prompt in view, if any. */
  turn: () => { ordinal: number; label: string } | undefined;
}

/**
 * Copy to the clipboard. Plain http on anything but localhost has no async clipboard,
 * so fall back to the old selection copy there.
 */
export async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = h("textarea", { readonly: true, class: "copy-buffer", "aria-hidden": "true" });
    area.value = text;
    document.body.append(area);
    area.select();
    try {
      return document.execCommand("copy");
    } catch {
      return false;
    } finally {
      area.remove();
    }
  }
}

async function copyLink(url: string, what: string): Promise<void> {
  toast((await copy(url)) ? `Copied ${what}` : `Couldn't copy; the link is ${url}`, 4000);
}

export function shareButton(opts: ShareOptions): HTMLElement {
  const button = h("button", { type: "button", class: "icon share", "aria-label": "Share", title: "Share" });
  button.append(shareIcon());
  return menuButton(button, "Share", (close) => {
    const act = (fn: () => void) => () => {
      close();
      fn();
    };
    const view = opts.view();
    const turn = opts.turn();
    const copyItem = (what: string, blurb: string, params: Record<string, string> = {}) =>
      menuItem(`Copy ${what}`, blurb, act(() => void copyLink(shareLink(opts.source, params), what)));
    const toPrompt = (withView: boolean) => {
      const suffix = withView ? " with current view" : "";
      if (!turn) return menuItem(`Copy link to this prompt${suffix}`, "Scroll to a prompt first", () => {}, { disabled: true });
      const what = `link to prompt ${turn.ordinal}${suffix}`;
      return copyItem(what, withView ? view.label : turn.label, { ...(withView ? { ui: view.ui } : {}), turn: String(turn.ordinal) });
    };
    const items = [
      copyItem("link", "Opens with the reader's own view settings"),
      copyItem("link with current view", view.label, { ui: view.ui }),
      toPrompt(false),
      toPrompt(true),
    ];
    const footText =
      opts.source.kind === "local"
        ? "Local links only open on this machine, while overshare serve runs"
        : opts.source.kind === "embedded"
          ? "Links open this file, so they work only where the file is saved or hosted"
          : undefined;
    const foot = footText ? [h("div", { class: "menu-foot" }, footText)] : [];
    return { children: [h("div", { class: "menu-head" }, "Share"), ...items, ...foot], items };
  });
}
