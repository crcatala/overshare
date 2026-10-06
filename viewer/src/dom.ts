import DOMPurify, { type Config } from "dompurify";
import { marked } from "marked";
import { asciiTable } from "./asciitable.ts";
import { h } from "./el.ts";
import type { Provenance } from "./source.ts";

export { append, h } from "./el.ts";

// Only marked's code-block language classes survive. Any other class would let transcript
// markdown borrow the viewer's own styles and draw a fake "You" prompt or tool call.
const CODE_LANGUAGE_CLASS = /^language-[\w+#.-]+$/;

DOMPurify.addHook("uponSanitizeAttribute", (_node, data) => {
  if (data.attrName !== "class") return;
  data.attrValue = data.attrValue.split(/\s+/).filter((c) => CODE_LANGUAGE_CLASS.test(c)).join(" ");
  if (!data.attrValue) data.keepAttr = false;
});

const SVG_NS = "http://www.w3.org/2000/svg";
const BLOCKED_ATTR = "data-remote-blocked";

/**
 * SVG presentation attributes that take url(). With no CSP, Chrome fetches cross-origin
 * references from all of these except filter (kept here in case other engines do).
 */
const SVG_CSS_URL_ATTRS = ["fill", "stroke", "filter", "mask", "clip-path", "marker-start", "marker-mid", "marker-end", "cursor"];
const COLOR_FUNCTIONS = new Set(["rgb", "rgba", "hsl", "hsla", "hwb", "lab", "lch", "oklab", "oklch", "color"]);

/** The host a URL would be fetched from, or undefined for data: and same-origin URLs. */
function remoteHost(value: string): string | undefined {
  try {
    const url = new URL(value.trim(), document.baseURI);
    return url.protocol === "data:" || url.origin === location.origin ? undefined : url.host || url.protocol;
  } catch {
    return "an invalid URL";
  }
}

/**
 * Whether a CSS value could fetch something. Allowlist, not a url( search: only colour
 * functions and url(#local-id) pass, and any backslash fails, because CSS escapes can
 * spell url( (Chrome fetches fill="\75 rl(https://…)").
 */
function cssCanFetch(value: string): boolean {
  if (value.includes("\\")) return true;
  for (const [, fn = "", next = ""] of value.matchAll(/([\w-]*)\(\s*['"]?\s*(.?)/g)) {
    const name = fn.toLowerCase();
    if (name === "url" ? next !== "#" : !COLOR_FUNCTIONS.has(name)) return true;
  }
  return false;
}

DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer nofollow");
  }
  // Remote media would tell the share's author (or whatever host a quoted URL points at)
  // who opened it and when, and can carry data out in its URL. The CSP blocks these too;
  // dropping them here keeps that true without it and lets us show a note instead.
  const svg = node.namespaceURI === SVG_NS;
  let blocked: string | undefined;
  // The element's own source: without it there is nothing to show, so it gets a note.
  // In SVG, href on anything but a link is a resource reference (<image>, <use>, <feImage>).
  for (const attr of svg && node.nodeName.toLowerCase() !== "a" ? ["src", "href", "xlink:href"] : ["src"]) {
    const value = node.getAttribute(attr);
    const host = value === null ? undefined : remoteHost(value);
    if (!host) continue;
    node.removeAttribute(attr);
    blocked ??= host;
  }
  // Secondary sources: dropping them leaves the element (and any valid src) as it is.
  for (const attr of ["poster", "background"]) {
    const value = node.getAttribute(attr);
    if (value !== null && remoteHost(value)) node.removeAttribute(attr);
  }
  // srcset lists several URLs (and data: URLs contain commas); nothing we render needs it.
  node.removeAttribute("srcset");
  if (svg) {
    for (const attr of SVG_CSS_URL_ATTRS) {
      const value = node.getAttribute(attr);
      if (value !== null && cssCanFetch(value)) node.removeAttribute(attr);
    }
  }
  // Set after attribute filtering; ALLOW_DATA_ATTR: false keeps shares from forging it.
  if (blocked) node.setAttribute(BLOCKED_ATTR, blocked);
});

marked.setOptions({ gfm: true, breaks: false });

/**
 * Transcripts are untrusted. Beyond DOMPurify's script/URL filtering: no styling hooks,
 * no ids/names (they would shadow the viewer's own elements, e.g. #tooltip or #turn-3),
 * and no form controls or dialogs (fake "paste your token here" boxes).
 */
const SANITIZE_OPTIONS: Config = {
  FORBID_TAGS: ["style", "form", "input", "button", "iframe", "textarea", "select", "option", "optgroup", "datalist", "dialog"],
  FORBID_ATTR: ["style", "id", "name"],
  ALLOW_DATA_ATTR: false,
};

const MEDIA_KIND: Record<string, string> = { img: "image", video: "video", audio: "audio" };

/**
 * Sanitize into a fragment (no serialize/re-parse round trip), then swap images, video
 * and audio whose remote source was dropped for a visible note, so readers know
 * something was there. SVG elements that lost their source are removed.
 */
function sanitize(html: string): DocumentFragment {
  const fragment = DOMPurify.sanitize(html, { ...SANITIZE_OPTIONS, RETURN_DOM_FRAGMENT: true });
  for (const el of fragment.querySelectorAll(`[${BLOCKED_ATTR}]`)) {
    const host = el.getAttribute(BLOCKED_ATTR)!;
    el.removeAttribute(BLOCKED_ATTR);
    // An HTML note wouldn't render inside <svg>, and the element has nothing left to draw.
    if (el.namespaceURI === SVG_NS) {
      el.remove();
      continue;
    }
    const kind = MEDIA_KIND[el.nodeName.toLowerCase()];
    if (!kind) continue;
    const alt = el.getAttribute("alt");
    el.replaceWith(
      h("span", { class: "remote-blocked", title: "Shared sessions never load remote content" }, `remote ${kind}${alt ? ` “${alt}”` : ""} not loaded (${host})`),
    );
  }
  return fragment;
}

/** Sanitize rendered markdown HTML to a string (for tests). */
export function sanitizeHtml(html: string): string {
  const div = document.createElement("div");
  div.append(sanitize(html));
  return div.innerHTML;
}

/**
 * Viewer presentation added after sanitizing (so these classes are ours, never the
 * share's): tables become text grids that re-wrap to the width, and code blocks get a
 * language label.
 */
function present(fragment: DocumentFragment): DocumentFragment {
  for (const table of fragment.querySelectorAll("table")) {
    // Nested tables (raw HTML) stay inside their parent's cell text.
    if (table.parentElement?.closest("table")) continue;
    // The grid keeps the table inside it (for screen readers), so swap via a placeholder.
    const spot = document.createComment("");
    table.replaceWith(spot);
    spot.replaceWith(asciiTable(table));
  }
  for (const pre of fragment.querySelectorAll("pre")) {
    if (pre.closest(".atable")) continue;
    const lang = pre.querySelector(":scope > code")?.className.match(/language-([\w+#.-]+)/)?.[1];
    const block = h("div", { class: "codeblock" }, lang ? h("span", { class: "codeblock-lang", "aria-hidden": "true" }, lang) : null);
    pre.replaceWith(block);
    block.append(pre);
  }
  return fragment;
}

/** Render untrusted markdown to sanitized HTML. */
export function markdown(text: string): HTMLElement {
  return h("div", { class: "md" }, present(sanitize(marked.parse(text, { async: false }) as string)));
}

/** Where the share was fetched from; everything else in the header is the sharer's own claim. */
export function provenanceLine(p: Provenance): HTMLElement {
  return h(
    "p",
    { class: "fine provenance" },
    "Loaded from ",
    p.href ? h("a", { href: p.href, target: "_blank", rel: "noopener noreferrer" }, p.label) : p.label,
    " · the transcript is shown as published and isn't verified",
  );
}

/** A <details> whose body is built only when first opened (keeps huge sessions light). */
export function lazyDetails(summary: Node, build: () => Node, opts: { open?: boolean; className?: string } = {}): HTMLDetailsElement {
  const details = h("details", { class: opts.className });
  details.append(h("summary", {}, summary));
  let built = false;
  const ensure = () => {
    if (built) return;
    built = true;
    details.append(build());
  };
  details.addEventListener("toggle", () => details.open && ensure());
  if (opts.open) {
    details.open = true;
    ensure();
  }
  return details;
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * A short confirmation at the bottom of the window ("Link copied"), read out by screen
 * readers: #toast is a live region in index.html. It is emptied when it fades, so the
 * same message is announced again next time.
 */
export function toast(text: string, ms = 2200): void {
  const el = document.getElementById("toast");
  if (!el) return;
  el.textContent = text;
  el.classList.add("is-on");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.remove("is-on");
    el.textContent = "";
  }, ms);
}

const tooltip = () => document.getElementById("tooltip") as HTMLDivElement;

/**
 * Hide the tooltip. Needed when its element is replaced while hovered: removed nodes
 * get no pointerleave, so the tooltip would stay up with stale content.
 */
export function hideTooltip(): void {
  const tip = document.getElementById("tooltip");
  if (tip) tip.hidden = true;
}

export interface TooltipOptions {
  /**
   * Pin the tooltip instead of following the pointer, for explanations: "below" the
   * element, or "left" of `beside` (default: the element), top-aligned with the element
   * — falling back to below when there's no room on the left.
   */
  anchor?: "below" | "left";
  beside?: () => Element;
  className?: string;
}

/**
 * Attach a hover/focus tooltip: plain-text lines (the first is the title), or a node built
 * by the caller for richer content (the token charts' cards).
 */
export function withTooltip(el: HTMLElement | SVGElement, lines: () => string[] | Node, opts: TooltipOptions = {}): void {
  const show = (x: number, y: number) => {
    const tip = tooltip();
    tip.className = `tooltip${opts.className ? ` ${opts.className}` : ""}`;
    const content = lines();
    tip.replaceChildren(...(Array.isArray(content) ? content.map((l, i) => h("div", { class: i === 0 ? "tip-title" : "tip-line" }, l)) : [content]));
    tip.hidden = false;
    const pad = 12;
    const { width, height } = tip.getBoundingClientRect();
    if (opts.anchor) {
      const r = el.getBoundingClientRect();
      const edge = (opts.beside?.() ?? el).getBoundingClientRect().left - 10;
      if (opts.anchor === "left" && edge - width >= 8) {
        tip.style.left = `${edge - width}px`;
        tip.style.top = `${Math.max(8, Math.min(window.innerHeight - height - 8, r.top - 7))}px`;
        return;
      }
      x = r.left - pad;
      y = r.bottom - 6;
    }
    const left = Math.min(window.innerWidth - width - 8, Math.max(8, x + pad));
    const top = y + pad + height > window.innerHeight ? y - height - pad : y + pad;
    tip.style.left = `${left}px`;
    tip.style.top = `${Math.max(8, top)}px`;
  };
  el.addEventListener("pointerenter", (e) => show((e as PointerEvent).clientX, (e as PointerEvent).clientY));
  if (!opts.anchor) el.addEventListener("pointermove", (e) => show((e as PointerEvent).clientX, (e as PointerEvent).clientY));
  el.addEventListener("pointerleave", () => (tooltip().hidden = true));
  el.addEventListener("focus", () => {
    const r = el.getBoundingClientRect();
    show(r.left, r.bottom);
  });
  el.addEventListener("blur", () => (tooltip().hidden = true));
}
