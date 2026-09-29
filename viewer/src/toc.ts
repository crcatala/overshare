/**
 * The contents rail: one row per prompt (with its time and tool count), optionally the
 * replies, tool runs and events inside each turn. Filterable; the turn in view is
 * highlighted and kept visible. Rows are buttons, not #links: the URL hash names the
 * share, so the viewer scrolls itself.
 */
import { plural } from "../../src/format.ts";
import { append, h } from "./dom.ts";
import { fold, hitRanges, matchesAll, queryTokens, splitByRanges } from "./filter.ts";
import { load, save } from "./prefs.ts";
import type { TurnInfo } from "./transcript.ts";

type Detail = "prompts" | "all";

/** Shorter words still filter, but a lone letter would light up half the rail. */
const MIN_HIGHLIGHT = 2;

/** A label the filter can match and highlight: the rail's text for a prompt, reply or tool run. */
interface Label {
  el: HTMLElement;
  text: string;
  folded: string;
  marked: boolean;
}

const labelOf = (el: HTMLElement, text: string): Label => ({ el, text, folded: fold(text), marked: false });

/** Redraws a label with the tokens highlighted, or plain when there are none. Touches the DOM only when it changes. */
function paint(label: Label, tokens: readonly string[]): void {
  const ranges = hitRanges(label.text, tokens.filter((t) => t.length >= MIN_HIGHLIGHT));
  if (!ranges.length && !label.marked) return;
  label.marked = ranges.length > 0;
  // One wrapper child: the label is a -webkit-box, which drops a whitespace-only text node
  // between two marks, so "USD fallback" would read "USDfallback".
  const pieces = splitByRanges(label.text, ranges).map((p) => (p.hit ? h("mark", { class: "toc-hit" }, p.text) : p.text));
  label.el.replaceChildren(ranges.length ? h("span", {}, ...pieces) : label.text);
}

interface Row {
  el: HTMLElement;
  own: Label;
  items: { el: HTMLElement; label: Label }[];
}

export function renderToc(turns: TurnInfo[], onJump: (id: string) => void) {
  let detail: Detail = load("toc-detail") === "all" ? "all" : "prompts";
  let tokens: string[] = [];
  const rows = new Map<number, Row>();

  const list = h(
    "ol",
    { class: "toc-list" },
    ...turns.map((t) => {
      const meta = [t.time, t.tools ? plural(t.tools, "tool") : ""].filter(Boolean).join(" · ");
      const ownLabel = h("span", { class: "toc-label" }, t.label);
      const items: Row["items"] = [];
      const el = h(
        "li",
        { class: `toc-turn${t.ordinal ? "" : " is-start"}${t.command ? " is-cmd" : ""}`, "data-turn": String(t.index) },
        h(
          "button",
          { type: "button", class: "toc-link", onclick: () => onJump(t.id), title: t.label },
          h("span", { class: "toc-n" }, t.ordinal ? String(t.ordinal) : "·"),
          h("span", { class: "toc-text" }, ownLabel, meta || t.errors ? h("span", { class: "toc-meta" }, meta, t.errors ? h("span", { class: "toc-err" }, ` · ${plural(t.errors, "error")}`) : null) : null),
        ),
        t.items.length
          ? h(
              "ol",
              { class: "toc-sub" },
              ...t.items.map((i) => {
                const label = h("span", { class: "toc-label" }, i.label);
                const item = h(
                  "li",
                  { class: `toc-item toc-k-${i.kind}${i.error ? " is-error" : ""}` },
                  h("button", { type: "button", class: "toc-link", onclick: () => onJump(i.id), title: i.label }, h("span", { class: "toc-glyph", "aria-hidden": "true" }), label),
                );
                items.push({ el: item, label: labelOf(label, i.label) });
                return item;
              }),
            )
          : null,
      );
      rows.set(t.index, { el, own: labelOf(ownLabel, t.label), items });
      return el;
    }),
  );
  const empty = h("p", { class: "toc-empty", hidden: true }, "No matches");

  // A turn stays when its own label or any of its items matches. Each label is matched on its
  // own, so the words that made a row appear are the words highlighted in it.
  const apply = () => {
    let shown = 0;
    for (const row of rows.values()) {
      let match = !tokens.length;
      const own = tokens.length > 0 && matchesAll(row.own.folded, tokens);
      paint(row.own, own ? tokens : []);
      for (const item of row.items) {
        const hit = tokens.length > 0 && matchesAll(item.label.folded, tokens);
        paint(item.label, hit ? tokens : []);
        // Without a filter, sub-items follow the detail setting; with one, matching items show.
        item.el.hidden = tokens.length ? !hit : detail === "prompts";
        match ||= hit;
      }
      match ||= own;
      row.el.hidden = !match;
      if (match) shown++;
    }
    empty.hidden = shown > 0;
    for (const b of seg.querySelectorAll("button")) b.setAttribute("aria-pressed", String(b.dataset.detail === detail));
  };

  const seg = h(
    "div",
    { class: "toc-seg", role: "group", "aria-label": "Outline detail" },
    ...(["prompts", "all"] as Detail[]).map((d) =>
      h(
        "button",
        {
          type: "button",
          "data-detail": d,
          onclick: () => {
            detail = d;
            save("toc-detail", d);
            apply();
          },
        },
        d,
      ),
    ),
  );
  const search = h("input", { type: "search", class: "toc-search", placeholder: "Filter…", "aria-label": "Filter the outline", spellcheck: "false", autocomplete: "off" });
  // Typing is coalesced to one pass per frame: the pass is cheap, but marks are DOM writes.
  let frame = 0;
  search.addEventListener("input", () => {
    tokens = queryTokens(search.value);
    frame ||= requestAnimationFrame(() => {
      frame = 0;
      apply();
    });
  });
  search.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      cancelAnimationFrame(frame);
      frame = 0;
      search.value = "";
      tokens = [];
      apply();
      search.blur();
    }
  });
  const scroller = h("div", { class: "toc-scroll" }, list, empty);
  apply();

  let current = -1;
  const setActive = (turnIndex: number) => {
    if (turnIndex === current) return;
    rows.get(current)?.el.classList.remove("on");
    current = turnIndex;
    const row = rows.get(turnIndex)?.el;
    if (!row) return;
    row.classList.add("on");
    // Keep the active row in view inside the rail without moving the page.
    const link = row.querySelector(".toc-link") as HTMLElement;
    const top = link.offsetTop; // the scroller is the offset parent
    if (top < scroller.scrollTop + 8 || top + link.offsetHeight > scroller.scrollTop + scroller.clientHeight - 8) {
      scroller.scrollTo({ top: Math.max(0, top - scroller.clientHeight / 3), behavior: "smooth" });
    }
  };

  const prompts = turns.filter((t) => t.ordinal).length;
  const el = h("div", { class: "toc" }, h("div", { class: "toc-tools" }, search, seg), scroller, h("div", { class: "toc-foot" }, `${plural(prompts, "prompt")} · `, h("kbd", {}, "j"), "/", h("kbd", {}, "k"), " to step"));
  return { el, setActive, focusSearch: () => search.focus() };
}
