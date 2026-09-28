import DOMPurify, { type Config } from "dompurify";
import { marked } from "marked";

type Child = Node | string | number | false | null | undefined;
type Attrs = Record<string, string | number | boolean | undefined | EventListener>;

/** Tiny element builder. Strings become text nodes (never HTML). */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) continue;
    if (key.startsWith("on") && typeof value === "function") el.addEventListener(key.slice(2), value as EventListener);
    else if (key === "class") el.className = String(value);
    else el.setAttribute(key, value === true ? "" : String(value));
  }
  append(el, children);
  return el;
}

export function append(el: Element, children: Child[]): void {
  for (const c of children) {
    if (c === false || c === null || c === undefined) continue;
    el.append(typeof c === "string" || typeof c === "number" ? document.createTextNode(String(c)) : c);
  }
}

// Only marked's code-block language classes survive. Any other class would let transcript
// markdown borrow the viewer's own styles and draw a fake "You" prompt or tool call.
const CODE_LANGUAGE_CLASS = /^language-[\w+#.-]+$/;

DOMPurify.addHook("uponSanitizeAttribute", (_node, data) => {
  if (data.attrName !== "class") return;
  data.attrValue = data.attrValue.split(/\s+/).filter((c) => CODE_LANGUAGE_CLASS.test(c)).join(" ");
  if (!data.attrValue) data.keepAttr = false;
});

/**
 * Attributes that make the browser fetch a URL as soon as the element exists ("*" applies
 * to every element). Links only load when clicked, so <a href> is left alone.
 */
const AUTO_LOAD_ATTRS: Record<string, string[]> = {
  "*": ["src", "srcset", "poster", "background"],
  image: ["href", "xlink:href"],
  use: ["href", "xlink:href"],
  feimage: ["href", "xlink:href"],
};
const BLOCKED_ATTR = "data-remote-blocked";

/** The host a URL would be fetched from, or undefined for data: and same-origin URLs. */
function remoteHost(value: string): string | undefined {
  try {
    const url = new URL(value.trim(), document.baseURI);
    return url.protocol === "data:" || url.origin === location.origin ? undefined : url.host || url.protocol;
  } catch {
    return "an invalid URL";
  }
}

DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer nofollow");
  }
  // Remote media would tell the share's author (or whatever host a quoted URL points at)
  // who opened it and when, and can carry data out in its URL. The CSP blocks these too;
  // dropping them here keeps that true without it and lets us show a placeholder.
  const tag = node.nodeName.toLowerCase();
  let blocked: string | undefined;
  for (const attr of [...AUTO_LOAD_ATTRS["*"]!, ...(AUTO_LOAD_ATTRS[tag] ?? [])]) {
    const value = node.getAttribute(attr);
    if (value === null) continue;
    // srcset lists several URLs (and data: URLs contain commas); nothing we render needs it.
    const host = remoteHost(attr === "srcset" ? (value.trim().split(/\s+/)[0] ?? "") : value);
    if (host || attr === "srcset") node.removeAttribute(attr);
    blocked ??= host;
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

const MEDIA_KIND: Record<string, string> = { img: "image", image: "image", video: "video", audio: "audio" };

/**
 * Sanitize into a fragment (no serialize/re-parse round trip), then swap media whose
 * remote source was dropped for a visible note, so readers know something was there.
 */
function sanitize(html: string): DocumentFragment {
  const fragment = DOMPurify.sanitize(html, { ...SANITIZE_OPTIONS, RETURN_DOM_FRAGMENT: true });
  for (const el of fragment.querySelectorAll(`[${BLOCKED_ATTR}]`)) {
    const kind = MEDIA_KIND[el.nodeName.toLowerCase()];
    const host = el.getAttribute(BLOCKED_ATTR)!;
    el.removeAttribute(BLOCKED_ATTR);
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

/** Render untrusted markdown to sanitized HTML. */
export function markdown(text: string): HTMLElement {
  return h("div", { class: "md" }, sanitize(marked.parse(text, { async: false }) as string));
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

const tooltip = () => document.getElementById("tooltip") as HTMLDivElement;

/** Attach a hover/focus tooltip with plain-text lines. */
export function withTooltip(el: HTMLElement | SVGElement, lines: () => string[]): void {
  const show = (x: number, y: number) => {
    const tip = tooltip();
    tip.replaceChildren(...lines().map((l, i) => h("div", { class: i === 0 ? "tip-title" : "tip-line" }, l)));
    tip.hidden = false;
    const pad = 12;
    const { width, height } = tip.getBoundingClientRect();
    const left = Math.min(window.innerWidth - width - 8, Math.max(8, x + pad));
    const top = y + pad + height > window.innerHeight ? y - height - pad : y + pad;
    tip.style.left = `${left}px`;
    tip.style.top = `${Math.max(8, top)}px`;
  };
  el.addEventListener("pointerenter", (e) => show((e as PointerEvent).clientX, (e as PointerEvent).clientY));
  el.addEventListener("pointermove", (e) => show((e as PointerEvent).clientX, (e as PointerEvent).clientY));
  el.addEventListener("pointerleave", () => (tooltip().hidden = true));
  el.addEventListener("focus", () => {
    const r = el.getBoundingClientRect();
    show(r.left, r.bottom);
  });
  el.addEventListener("blur", () => (tooltip().hidden = true));
}
