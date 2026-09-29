/**
 * The contents rail: one row per prompt (with its time and tool count), optionally the
 * replies, tool runs and events inside each turn. Searchable; the turn in view is
 * highlighted and kept visible. Rows are buttons, not #links: the URL hash names the
 * share, so the viewer scrolls itself.
 *
 * The search matches the rail's own labels, and, given an index, the whole transcript:
 * an entry whose text matches but whose label doesn't gets a snippet row under its turn.
 */
import { plural } from "../../src/format.ts";
import { append, h } from "./dom.ts";
import { fold, hitRanges, MIN_HIGHLIGHT, matchesAll, queryTokens, splitByRanges } from "./filter.ts";
import { outputOnlyTurns, search as searchIndex, snippet, type SearchDoc, type SearchHit } from "./search.ts";
import { promptId, type TurnInfo } from "./transcript.ts";
import type { TocDetail } from "./viewsettings.ts";

export interface TocOptions {
  detail: TocDetail;
  onDetail: (d: TocDetail) => void;
  /** The filter's words changed or were cleared. */
  onClear?: () => void;
  /** The full-text index, built on first use. Without it the search matches labels only. */
  index?: () => readonly SearchDoc[];
}

const SCOPE_TITLE = "Also search what tools returned: command output, file contents, subagent results";

/** Snippet rows shown per turn before a "+N more" opener. */
const SNIPPETS_PER_TURN = 3;

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

/**
 * What a click on a matching row hands the viewer: the words to outline, and the transcript
 * ids to look for them in. `reveal`: the words may be in a collapsed part of the entry
 * (a snippet row matched its full text), so open it if they are not visible.
 */
export interface TocHit {
  ids: string[];
  tokens: string[];
  reveal?: boolean;
}

interface Row {
  el: HTMLElement;
  own: Label;
  items: { el: HTMLElement; label: Label; ids: string[] }[];
  /** Snippet rows for entries that matched on text their labels don't show. */
  found: HTMLElement;
}

/** "Bash output" and the like, then the excerpt around the first hit. */
function snippetRow(hit: SearchHit, tokens: readonly string[], onClick: () => void): HTMLElement {
  const s = snippet(hit.field.text, tokens, undefined, hit.field.markdown);
  const pieces = splitByRanges(s.text, s.ranges).map((p) => (p.hit ? h("mark", { class: "toc-hit" }, p.text) : p.text));
  return h(
    "li",
    { class: "toc-item toc-k-found" },
    h(
      "button",
      { type: "button", class: "toc-link", onclick: onClick, title: `${hit.field.source}: ${s.text}` },
      h("span", { class: "toc-glyph", "aria-hidden": "true" }),
      h("span", { class: "toc-label toc-snip" }, h("span", {}, h("span", { class: "toc-src" }, hit.field.source), " ", ...pieces)),
    ),
  );
}

/**
 * `onJump` also gets the hit when the row was clicked while the filter matched it, so the
 * viewer can outline the words in the transcript; `opts.onClear` fires when the filter's words change.
 */
export function renderToc(turns: TurnInfo[], onJump: (id: string, hit?: TocHit) => void, opts: TocOptions) {
  let detail = opts.detail;
  let tokens: string[] = [];
  /** Whether the full-text search also looks in tool output. Off by default: see search.ts. */
  let output = false;
  let index: readonly SearchDoc[] | undefined;
  const docs = () => (index ??= opts.index?.() ?? []);
  let hasOutput: boolean | undefined;
  /** Turns whose snippet list was opened past the first few, for the current words. */
  const opened = new Set<number>();
  /** The words and scope the snippet rows were last drawn for: they are rebuilt only when these change. */
  let drawn = "";
  const rows = new Map<number, Row>();
  const jump = (label: Label, id: string, ids = [id]) => onJump(id, tokens.length && matchesAll(label.folded, tokens) ? { ids, tokens } : undefined);

  const list = h(
    "ol",
    { class: "toc-list" },
    ...turns.map((t) => {
      const meta = [t.time, t.tools ? plural(t.tools, "tool") : ""].filter(Boolean).join(" · ");
      const ownEl = h("span", { class: "toc-label" }, t.label);
      const own = labelOf(ownEl, t.label);
      const items: Row["items"] = [];
      const el = h(
        "li",
        { class: `toc-turn${t.ordinal ? "" : " is-start"}${t.command ? " is-cmd" : ""}`, "data-turn": String(t.index) },
        h(
          "button",
          { type: "button", class: "toc-link", onclick: () => jump(own, t.id), title: t.label },
          h("span", { class: "toc-n" }, t.ordinal ? String(t.ordinal) : "·"),
          h("span", { class: "toc-text" }, ownEl, meta || t.errors ? h("span", { class: "toc-meta" }, meta, t.errors ? h("span", { class: "toc-err" }, ` · ${plural(t.errors, "error")}`) : null) : null),
        ),
        t.items.length
          ? h(
              "ol",
              { class: "toc-sub" },
              ...t.items.map((i) => {
                const labelEl = h("span", { class: "toc-label" }, i.label);
                const label = labelOf(labelEl, i.label);
                const item = h(
                  "li",
                  { class: `toc-item toc-k-${i.kind}${i.error ? " is-error" : ""}` },
                  h("button", { type: "button", class: "toc-link", onclick: () => jump(label, i.id, i.ids), title: i.label }, h("span", { class: "toc-glyph", "aria-hidden": "true" }), labelEl),
                );
                items.push({ el: item, label, ids: i.ids ?? [i.id] });
                return item;
              }),
            )
          : null,
      );
      const found = h("ol", { class: "toc-sub toc-found", hidden: true });
      el.append(found);
      rows.set(t.index, { el, own, items, found });
      return el;
    }),
  );
  const empty = h("p", { class: "toc-empty", hidden: true }, "No matches");

  const count = h("span", { class: "toc-count" });
  const extra = h("span", { class: "toc-extra" });
  const scope = h(
    "button",
    {
      type: "button",
      class: "toc-scope",
      "aria-pressed": "false",
      title: SCOPE_TITLE,
      onclick: () => {
        output = !output;
        opts.onClear?.();
        apply();
      },
    },
    "tool output",
    extra,
  );
  const status = h("div", { class: "toc-status", hidden: true }, count, opts.index ? scope : null);

  const drawFound = (row: Row, turn: number, hits: SearchHit[]) => {
    const shown = opened.has(turn) ? hits : hits.slice(0, SNIPPETS_PER_TURN);
    const rest = hits.length - shown.length;
    const more =
      rest > 0
        ? h(
            "li",
            { class: "toc-more" },
            h(
              "button",
              {
                type: "button",
                onclick: () => {
                  opened.add(turn);
                  drawFound(row, turn, hits);
                },
              },
              `+${rest} more in this turn`,
            ),
          )
        : null;
    row.found.replaceChildren(...shown.map((hit) => snippetRow(hit, tokens, () => onJump(hit.doc.id, { ids: [hit.doc.id], tokens, reveal: true }))));
    if (more) row.found.append(more);
    row.found.hidden = !hits.length;
  };

  // A turn stays when its own label or any of its items matches, or, with an index, when any
  // of its entries holds every word. Each label is matched on its own, so the words that made
  // a row appear are the words highlighted in it; an entry that matched on text its label
  // doesn't show gets a snippet row instead.
  const apply = () => {
    const key = tokens.length ? `${output}:${tokens.join(" ")}` : "";
    const redraw = key !== drawn;
    if (redraw) opened.clear();
    drawn = key;
    const byTurn = new Map<number, SearchHit[]>();
    if (tokens.length && opts.index) {
      for (const hit of searchIndex(docs(), tokens, output)) {
        const list = byTurn.get(hit.doc.turn) ?? [];
        list.push(hit);
        byTurn.set(hit.doc.turn, list);
      }
    }
    let shown = 0;
    let entries = 0;
    for (const [turn, row] of rows) {
      let match = !tokens.length;
      const own = tokens.length > 0 && matchesAll(row.own.folded, tokens);
      paint(row.own, own ? tokens : []);
      // Entries a highlighted label already explains don't need a snippet too.
      const explained = new Set<string>();
      if (own) explained.add(promptId(turn));
      for (const item of row.items) {
        const hit = tokens.length > 0 && matchesAll(item.label.folded, tokens);
        paint(item.label, hit ? tokens : []);
        // Without a filter, sub-items follow the detail setting; with one, matching items show.
        item.el.hidden = tokens.length ? !hit : detail === "prompts";
        if (hit) for (const id of item.ids) explained.add(id);
        match ||= hit;
      }
      const hits = byTurn.get(turn) ?? [];
      entries += hits.length;
      match ||= own || hits.length > 0;
      if (redraw) drawFound(row, turn, hits.filter((hit) => !explained.has(hit.doc.id)));
      row.el.hidden = !match;
      if (match) shown++;
    }
    empty.hidden = shown > 0;
    status.hidden = !tokens.length;
    if (tokens.length) {
      count.textContent = plural(shown, "turn");
      count.title = opts.index ? `${plural(entries, "entry", "entries")} hold every word` : "";
      const more = opts.index && !output ? outputOnlyTurns(docs(), tokens, new Set([...rows].filter(([, r]) => !r.el.hidden).map(([t]) => t))) : 0;
      extra.textContent = more ? ` +${more}` : "";
      scope.title = more ? `${plural(more, "more turn")} ${more === 1 ? "matches" : "match"} in tool output: command output, file contents, subagent results` : SCOPE_TITLE;
      scope.setAttribute("aria-pressed", String(output));
      // Brief and minimal views keep no tool output: nothing to switch on.
      hasOutput ??= docs().some((d) => d.fields.some((f) => f.output));
      scope.hidden = !hasOutput;
    }
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
  const search = h("input", {
    type: "search",
    class: "toc-search",
    placeholder: opts.index ? "Search…" : "Filter…",
    "aria-label": opts.index ? "Search the session" : "Filter the outline",
    spellcheck: "false",
    autocomplete: "off",
  });
  // Folding the whole session takes a moment on a big one: do it before the first keystroke.
  search.addEventListener("focus", () => void docs(), { once: true });
  // Typing is coalesced to one pass per frame: the pass is cheap, but marks are DOM writes.
  let frame = 0;
  search.addEventListener("input", () => {
    const next = queryTokens(search.value);
    // A trailing space or "-" leaves the words as they were, so their outlines still apply.
    if (next.length !== tokens.length || next.some((t, i) => t !== tokens[i])) opts.onClear?.();
    tokens = next;
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
      opts.onClear?.();
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
  const el = h("div", { class: "toc" }, h("div", { class: "toc-tools" }, search, seg), status, scroller, h("div", { class: "toc-foot" }, `${plural(prompts, "prompt")} · `, h("kbd", {}, "j"), "/", h("kbd", {}, "k"), " to step"));
  return { el, setActive, focusSearch: () => search.focus() };
}
