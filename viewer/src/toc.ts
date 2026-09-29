/**
 * The contents rail: one row per prompt (with its time and tool count), optionally the
 * replies, tool runs and events inside each turn. Filterable; the turn in view is
 * highlighted and kept visible. Rows are buttons, not #links: the URL hash names the
 * share, so the viewer scrolls itself.
 */
import { plural } from "../../src/format.ts";
import { h } from "./dom.ts";
import type { TurnInfo } from "./transcript.ts";
import type { TocDetail } from "./viewsettings.ts";

export interface TocOptions {
  detail: TocDetail;
  onDetail: (d: TocDetail) => void;
}

export function renderToc(turns: TurnInfo[], onJump: (id: string) => void, opts: TocOptions) {
  let detail = opts.detail;
  let query = "";
  const rows = new Map<number, HTMLElement>();

  const list = h(
    "ol",
    { class: "toc-list" },
    ...turns.map((t) => {
      const meta = [t.time, t.tools ? plural(t.tools, "tool") : ""].filter(Boolean).join(" · ");
      const row = h(
        "li",
        { class: `toc-turn${t.ordinal ? "" : " is-start"}${t.command ? " is-cmd" : ""}`, "data-turn": String(t.index) },
        h(
          "button",
          { type: "button", class: "toc-link", onclick: () => onJump(t.id), title: t.label },
          h("span", { class: "toc-n" }, t.ordinal ? String(t.ordinal) : "·"),
          h("span", { class: "toc-text" }, h("span", { class: "toc-label" }, t.label), meta || t.errors ? h("span", { class: "toc-meta" }, meta, t.errors ? h("span", { class: "toc-err" }, ` · ${plural(t.errors, "error")}`) : null) : null),
        ),
        t.items.length
          ? h(
              "ol",
              { class: "toc-sub" },
              ...t.items.map((i) =>
                h(
                  "li",
                  { class: `toc-item toc-k-${i.kind}${i.error ? " is-error" : ""}`, "data-label": i.label.toLowerCase() },
                  h("button", { type: "button", class: "toc-link", onclick: () => onJump(i.id), title: i.label }, h("span", { class: "toc-glyph", "aria-hidden": "true" }), h("span", { class: "toc-label" }, i.label)),
                ),
              ),
            )
          : null,
      );
      row.dataset.label = `${t.label} ${t.items.map((i) => i.label).join(" ")}`.toLowerCase();
      rows.set(t.index, row);
      return row;
    }),
  );
  const empty = h("p", { class: "toc-empty", hidden: true }, "No matches");

  const apply = () => {
    let shown = 0;
    for (const row of rows.values()) {
      const match = !query || (row.dataset.label ?? "").includes(query);
      row.hidden = !match;
      if (match) shown++;
      // Without a filter, sub-items follow the detail setting; with one, matching items show.
      for (const item of row.querySelectorAll<HTMLElement>(".toc-item")) {
        item.hidden = query ? !(item.dataset.label ?? "").includes(query) : detail === "prompts";
      }
    }
    empty.hidden = shown > 0;
    for (const b of seg.querySelectorAll("button")) b.setAttribute("aria-pressed", String(b.dataset.detail === detail));
  };

  const seg = h(
    "div",
    { class: "toc-seg", role: "group", "aria-label": "Outline detail" },
    ...(["prompts", "all"] as TocDetail[]).map((d) =>
      h(
        "button",
        {
          type: "button",
          "data-detail": d,
          onclick: () => {
            detail = d;
            opts.onDetail(d);
            apply();
          },
        },
        d,
      ),
    ),
  );
  const search = h("input", { type: "search", class: "toc-search", placeholder: "Filter…", "aria-label": "Filter the outline", spellcheck: "false", autocomplete: "off" });
  search.addEventListener("input", () => {
    query = search.value.trim().toLowerCase();
    apply();
  });
  search.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      search.value = "";
      query = "";
      apply();
      search.blur();
    }
  });
  const scroller = h("div", { class: "toc-scroll" }, list, empty);
  apply();

  let current = -1;
  const setActive = (turnIndex: number) => {
    if (turnIndex === current) return;
    rows.get(current)?.classList.remove("on");
    current = turnIndex;
    const row = rows.get(turnIndex);
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
