import DOMPurify from "dompurify";
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

DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer nofollow");
  }
});

marked.setOptions({ gfm: true, breaks: false });

/** Render untrusted markdown to sanitized HTML. */
export function markdown(text: string): HTMLElement {
  const div = h("div", { class: "md" });
  div.innerHTML = DOMPurify.sanitize(marked.parse(text, { async: false }) as string, {
    FORBID_TAGS: ["style", "form", "input", "button", "iframe"],
    FORBID_ATTR: ["style"],
  });
  return div;
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
