/**
 * Markdown tables drawn as text, the way a terminal renders them, but re-laid out to
 * whatever width is available: columns shrink (widest first, keeping words whole while
 * they can), cells wrap, and when even that can't fit, rows are stacked as
 * "header  value" records. Nothing ever scrolls sideways.
 *
 * The layout is a pure function over cell text (tested on its own). The DOM side keeps
 * the original <table> for screen readers and redraws the text grid when its container
 * changes width or fonts finish loading.
 */
import { h } from "./el.ts";

export type TableStyle = "rounded" | "square" | "ascii" | "minimal";
export type Align = "left" | "center" | "right";

/** Inline formatting a cell run keeps (links stay clickable). */
export interface RunStyle {
  strong?: boolean;
  em?: boolean;
  code?: boolean;
  del?: boolean;
  href?: string;
}

/** One grapheme with its terminal width (1, or 2 for wide/emoji) and style index. */
export interface Glyph {
  c: string;
  w: 1 | 2;
  s: number;
}

export interface TableModel {
  head: Glyph[][];
  body: Glyph[][][];
  align: Align[];
  styles: RunStyle[];
}

/** A line of output: border text, or a run of cell glyphs. */
export type Seg = { kind: "border"; text: string } | { kind: "cell"; glyphs: Glyph[]; head: boolean };
export type Line = Seg[];

const BORDERS: Record<Exclude<TableStyle, "minimal">, { h: string; v: string; hh: string; tl: string; tm: string; tr: string; ml: string; mm: string; mr: string; hl: string; hm: string; hr: string; bl: string; bm: string; br: string }> = {
  rounded: { h: "─", v: "│", hh: "─", tl: "╭", tm: "┬", tr: "╮", ml: "├", mm: "┼", mr: "┤", hl: "├", hm: "┼", hr: "┤", bl: "╰", bm: "┴", br: "╯" },
  square: { h: "─", v: "│", hh: "═", tl: "┌", tm: "┬", tr: "┐", ml: "├", mm: "┼", mr: "┤", hl: "╞", hm: "╪", hr: "╡", bl: "└", bm: "┴", br: "┘" },
  ascii: { h: "-", v: "|", hh: "=", tl: "+", tm: "+", tr: "+", ml: "+", mm: "+", mr: "+", hl: "+", hm: "+", hr: "+", bl: "+", bm: "+", br: "+" },
};

// ---------- text measurement ----------

const segmenter = typeof Intl !== "undefined" && "Segmenter" in Intl ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : undefined;
const WIDE = /\p{Emoji_Presentation}|\p{Extended_Pictographic}️|[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/u;

export function graphemes(text: string): string[] {
  return segmenter ? Array.from(segmenter.segment(text), (s) => s.segment) : Array.from(text);
}

export function glyphWidth(g: string): 1 | 2 {
  return WIDE.test(g) ? 2 : 1;
}

export function toGlyphs(text: string, s = 0): Glyph[] {
  return graphemes(text).map((c) => ({ c, w: glyphWidth(c), s }));
}

const width = (gs: Glyph[]): number => gs.reduce((n, g) => n + g.w, 0);
const isSpace = (g: Glyph) => g.c === " " || g.c === "\t";

/** Split a cell into its hard lines (from <br>), with whitespace collapsed. */
function hardLines(cell: Glyph[]): Glyph[][] {
  const lines: Glyph[][] = [[]];
  for (const g of cell) {
    if (g.c === "\n") lines.push([]);
    else lines[lines.length - 1]!.push(isSpace(g) ? { ...g, c: " " } : g);
  }
  return lines.map((l) => {
    const out: Glyph[] = [];
    for (const g of l) if (!(isSpace(g) && (out.length === 0 || isSpace(out[out.length - 1]!)))) out.push(g);
    while (out.length && isSpace(out[out.length - 1]!)) out.pop();
    return out;
  });
}

function words(line: Glyph[]): Glyph[][] {
  const out: Glyph[][] = [];
  let cur: Glyph[] = [];
  for (const g of line) {
    if (isSpace(g)) {
      if (cur.length) out.push(cur);
      cur = [];
    } else cur.push(g);
  }
  if (cur.length) out.push(cur);
  return out;
}

/** Word-wrap a cell to `w` columns; words longer than a line are broken. */
export function wrapCell(cell: Glyph[], w: number): Glyph[][] {
  const out: Glyph[][] = [];
  for (const line of hardLines(cell)) {
    let cur: Glyph[] = [];
    let curW = 0;
    const flush = () => {
      out.push(cur);
      cur = [];
      curW = 0;
    };
    const ws = words(line);
    if (!ws.length) out.push([]);
    for (const word of ws) {
      const ww = width(word);
      const gap = cur.length ? 1 : 0;
      if (curW + gap + ww <= w) {
        if (gap) cur.push({ c: " ", w: 1, s: word[0]!.s });
        cur.push(...word);
        curW += gap + ww;
        continue;
      }
      if (ww <= w) {
        flush();
        cur.push(...word);
        curW = ww;
        continue;
      }
      // Too long for any line: start it on the current line if a useful piece fits.
      if (cur.length && w - curW - 1 < Math.min(4, w)) flush();
      else if (cur.length) {
        cur.push({ c: " ", w: 1, s: word[0]!.s });
        curW += 1;
      }
      for (const g of word) {
        if (curW + g.w > w && cur.length) flush();
        cur.push(g);
        curW += g.w;
      }
    }
    if (cur.length) out.push(cur);
  }
  return out.length ? out : [[]];
}

// ---------- layout ----------

function naturalWidth(cell: Glyph[]): number {
  return Math.max(0, ...hardLines(cell).map(width));
}

function longestWord(cell: Glyph[]): number {
  return Math.max(0, ...hardLines(cell).flatMap(words).map(width));
}

/** Shrink the widest column (above its floor) one step at a time until the row fits. */
function shrink(widths: number[], floors: number[], avail: number): void {
  let total = widths.reduce((a, b) => a + b, 0);
  while (total > avail) {
    let widest = -1;
    for (let i = 0; i < widths.length; i++) {
      if (widths[i]! > floors[i]! && (widest < 0 || widths[i]! > widths[widest]!)) widest = i;
    }
    if (widest < 0) return;
    widths[widest]!--;
    total--;
  }
}

/** Grow `base` toward `target` by `extra` columns, in proportion to what each still wants. */
function grow(base: number[], target: number[], extra: number): number[] {
  const want = base.map((b, i) => Math.max(0, target[i]! - b));
  const total = want.reduce((a, b) => a + b, 0);
  if (total <= extra) return target.map((t, i) => Math.max(t, base[i]!));
  const share = want.map((w) => (w * extra) / total);
  const out = base.map((b, i) => b + Math.floor(share[i]!));
  // Hand out what rounding left over, largest remainder first.
  let left = extra - share.reduce((a, s) => a + Math.floor(s), 0);
  const order = share.map((s, i) => [s - Math.floor(s), i] as const).sort((a, b) => b[0] - a[0]);
  for (const [, i] of order) {
    if (left <= 0) break;
    if (out[i]! < target[i]!) {
      out[i]!++;
      left--;
    }
  }
  return out;
}

/**
 * Column widths for `cols` characters of space, or null when the columns cannot fit
 * even at their minimum (the caller then stacks rows instead). Like a browser's auto
 * table layout: every column keeps its longest word (capped, so one long path can't
 * hog the row), and the rest of the space goes to columns in proportion to how much
 * body text they hold, so a long header wraps before a long cell does.
 */
export function columnWidths(model: TableModel, cols: number, style: TableStyle): number[] | null {
  const n = model.head.length;
  if (n === 0) return [];
  const overhead = style === "minimal" ? 2 * (n - 1) : 3 * n + 1;
  const avail = cols - overhead;
  const rows = [model.head, ...model.body];
  const full = Array.from({ length: n }, (_, i) => Math.max(1, ...rows.map((r) => naturalWidth(r[i] ?? []))));
  if (full.reduce((a, b) => a + b, 0) <= avail) return full;
  const soft = full.map((f, i) => Math.min(f, Math.max(3, Math.min(18, Math.max(...rows.map((r) => longestWord(r[i] ?? [])))))));
  const softSum = soft.reduce((a, b) => a + b, 0);
  if (softSum > avail) {
    // Not even whole words fit. Wide tables read better as stacked records than with
    // every word broken; one or two columns (say, a long URL) can break words instead.
    if (n >= 3) return null;
    const widths = soft.slice();
    shrink(widths, soft.map((w) => Math.min(w, 4)), avail);
    return widths.reduce((a, b) => a + b, 0) <= avail ? widths : null;
  }
  const body = soft.map((w, i) => Math.max(w, ...model.body.map((r) => naturalWidth(r[i] ?? []))));
  const bodySum = body.reduce((a, b) => a + b, 0);
  if (bodySum <= avail) return grow(body, full, avail - bodySum);
  return grow(soft, body, avail - softSum);
}

function pad(glyphs: Glyph[], w: number, align: Align): Seg[] {
  const space = Math.max(0, w - width(glyphs));
  const left = align === "right" ? space : align === "center" ? Math.floor(space / 2) : 0;
  return [
    ...(left ? [{ kind: "border" as const, text: " ".repeat(left) }] : []),
    { kind: "cell" as const, glyphs, head: false },
    ...(space - left ? [{ kind: "border" as const, text: " ".repeat(space - left) }] : []),
  ];
}

function rowLines(cells: Glyph[][], widths: number[], align: Align[], head: boolean, style: TableStyle): Line[] {
  const wrapped = widths.map((w, i) => wrapCell(cells[i] ?? [], w));
  const height = Math.max(...wrapped.map((c) => c.length));
  const lines: Line[] = [];
  const v = style === "minimal" ? "" : BORDERS[style].v;
  for (let l = 0; l < height; l++) {
    const line: Line = [];
    if (v) line.push({ kind: "border", text: `${v} ` });
    widths.forEach((w, i) => {
      const segs = pad(wrapped[i]![l] ?? [], w, align[i] ?? "left");
      for (const s of segs) if (s.kind === "cell") s.head = head;
      line.push(...segs);
      if (i < widths.length - 1) line.push({ kind: "border", text: v ? ` ${v} ` : "  " });
    });
    if (v) line.push({ kind: "border", text: ` ${v}` });
    lines.push(line);
  }
  return lines;
}

function rule(widths: number[], l: string, m: string, r: string, fill: string): Line {
  return [{ kind: "border", text: l + widths.map((w) => fill.repeat(w + 2)).join(m) + r }];
}

/** Rows as "header  value" records, for widths too narrow for columns. */
function stacked(model: TableModel, cols: number, style: TableStyle): Line[] {
  const labelW = Math.max(1, Math.min(Math.max(...model.head.map(naturalWidth)), Math.floor(cols * 0.4)));
  const valueW = Math.max(4, cols - labelW - 2);
  const lines: Line[] = [];
  model.body.forEach((row, r) => {
    if (r > 0) lines.push([{ kind: "border", text: style === "minimal" ? "" : BORDERS[style].h.repeat(Math.min(cols, labelW + 2 + valueW)) }]);
    model.head.forEach((label, i) => {
      const labelLines = wrapCell(label, labelW);
      const valueLines = wrapCell(row[i] ?? [], valueW);
      for (let l = 0; l < Math.max(labelLines.length, valueLines.length); l++) {
        lines.push([...pad(labelLines[l] ?? [], labelW, "left").map((s) => (s.kind === "cell" ? { ...s, head: true } : s)), { kind: "border", text: "  " }, { kind: "cell", glyphs: valueLines[l] ?? [], head: false }]);
      }
    });
  });
  return lines;
}

export function layoutTable(model: TableModel, cols: number, style: TableStyle): Line[] {
  const widths = columnWidths(model, cols, style);
  if (!widths) return stacked(model, cols, style);
  const multiline = model.body.some((row) => widths.some((w, i) => wrapCell(row[i] ?? [], w).length > 1));
  const lines: Line[] = [];
  if (style === "minimal") {
    lines.push(...rowLines(model.head, widths, model.align, true, style));
    lines.push([{ kind: "border", text: widths.map((w) => "─".repeat(w)).join("  ") }]);
    model.body.forEach((row, r) => {
      if (r > 0 && multiline) lines.push([{ kind: "border", text: "" }]);
      lines.push(...rowLines(row, widths, model.align, false, style));
    });
    return lines;
  }
  const b = BORDERS[style];
  lines.push(rule(widths, b.tl, b.tm, b.tr, b.h));
  lines.push(...rowLines(model.head, widths, model.align, true, style));
  lines.push(rule(widths, b.hl, b.hm, b.hr, b.hh));
  model.body.forEach((row, r) => {
    if (r > 0 && multiline) lines.push(rule(widths, b.ml, b.mm, b.mr, b.h));
    lines.push(...rowLines(row, widths, model.align, false, style));
  });
  lines.push(rule(widths, b.bl, b.bm, b.br, b.h));
  return lines;
}

/** Plain text of laid-out lines (tests, and a sanity check that rows line up). */
export function linesToText(lines: Line[]): string {
  return lines.map((l) => l.map((s) => (s.kind === "border" ? s.text : s.glyphs.map((g) => g.c).join(""))).join("")).join("\n");
}

export function lineWidth(line: Line): number {
  return line.reduce((n, s) => n + (s.kind === "border" ? s.text.length : width(s.glyphs)), 0);
}

// ---------- DOM ----------

/** Read a sanitized <table> into cell glyphs, keeping inline formatting and links. */
export function tableModel(table: HTMLTableElement): TableModel {
  const styles: RunStyle[] = [{}];
  const styleIndex = new Map<string, number>([["{}", 0]]);
  const styleOf = (s: RunStyle): number => {
    const key = JSON.stringify(s);
    let i = styleIndex.get(key);
    if (i === undefined) {
      i = styles.length;
      styles.push(s);
      styleIndex.set(key, i);
    }
    return i;
  };
  const cellGlyphs = (cell: Element): Glyph[] => {
    const out: Glyph[] = [];
    const walk = (node: Node, style: RunStyle) => {
      if (node.nodeType === 3) {
        out.push(...toGlyphs((node.textContent ?? "").replace(/\s+/g, " "), styleOf(style)));
        return;
      }
      if (node.nodeType !== 1) return;
      const el = node as Element;
      const tag = el.tagName.toLowerCase();
      if (tag === "br") {
        out.push({ c: "\n", w: 1, s: 0 });
        return;
      }
      const next = { ...style };
      if (tag === "strong" || tag === "b") next.strong = true;
      if (tag === "em" || tag === "i") next.em = true;
      if (tag === "code") next.code = true;
      if (tag === "del" || tag === "s") next.del = true;
      if (tag === "a" && el.getAttribute("href")) next.href = el.getAttribute("href")!;
      for (const child of Array.from(el.childNodes)) walk(child, next);
    };
    for (const child of Array.from(cell.childNodes)) walk(child, {});
    // Trim leading whitespace (trailing is trimmed per line in the layout).
    while (out.length && isSpace(out[0]!)) out.shift();
    return out;
  };
  const rowsOf = (section: string) =>
    Array.from(table.querySelectorAll(`:scope > ${section} > tr`)).map((tr) => Array.from(tr.children).filter((c) => c.tagName === "TH" || c.tagName === "TD"));
  let headRows = rowsOf("thead");
  let bodyRows = [...rowsOf("tbody"), ...rowsOf(":not(thead):not(tbody)")];
  if (!headRows.length) {
    // Raw HTML tables may skip <thead>; treat the first row as the header.
    const all = Array.from(table.querySelectorAll("tr")).map((tr) => Array.from(tr.children));
    headRows = all.slice(0, 1);
    bodyRows = all.slice(1);
  }
  const headCells = headRows[0] ?? [];
  const n = Math.max(headCells.length, ...bodyRows.map((r) => r.length));
  const align: Align[] = Array.from({ length: n }, (_, i) => {
    const a = (headCells[i]?.getAttribute("align") ?? (headCells[i] as HTMLElement | undefined)?.style?.textAlign ?? "").toLowerCase();
    return a === "center" || a === "right" ? a : "left";
  });
  const fill = (cells: Element[]) => Array.from({ length: n }, (_, i) => (cells[i] ? cellGlyphs(cells[i]!) : []));
  return { head: fill(headCells), body: bodyRows.map(fill), align, styles };
}

let tableStyle: TableStyle = "rounded";
export function setTableStyle(style: TableStyle): void {
  tableStyle = style;
  relayoutTables();
}

function renderLines(pre: HTMLElement, lines: Line[], model: TableModel): void {
  const frag = document.createDocumentFragment();
  lines.forEach((line, i) => {
    if (i) frag.append("\n");
    for (const seg of line) {
      if (seg.kind === "border") {
        if (seg.text.trim()) frag.append(h("span", { class: "at-b" }, seg.text));
        else frag.append(seg.text);
        continue;
      }
      // Group consecutive glyphs of the same style into one element.
      let start = 0;
      while (start < seg.glyphs.length) {
        const s = seg.glyphs[start]!.s;
        let end = start;
        while (end < seg.glyphs.length && seg.glyphs[end]!.s === s) end++;
        const style = model.styles[s] ?? {};
        const cls = [seg.head ? "at-h" : "", style.strong ? "at-strong" : "", style.em ? "at-em" : "", style.code ? "at-code" : "", style.del ? "at-del" : ""].filter(Boolean).join(" ");
        const parts: (string | Node)[] = [];
        let text = "";
        for (const g of seg.glyphs.slice(start, end)) {
          if (g.w === 2) {
            if (text) parts.push(text);
            text = "";
            // Emoji and CJK render at unpredictable widths; pin them to two columns.
            parts.push(h("span", { class: "at-wide" }, g.c));
          } else text += g.c;
        }
        if (text) parts.push(text);
        const el = style.href ? h("a", { href: style.href, target: "_blank", rel: "noopener noreferrer nofollow", class: cls || undefined }) : cls ? h("span", { class: cls }) : undefined;
        if (el) {
          el.append(...parts);
          frag.append(el);
        } else frag.append(...parts);
        start = end;
      }
    }
  });
  pre.replaceChildren(frag);
}

const relayouts = new WeakMap<Element, () => void>();
let observer: ResizeObserver | undefined;

function relayoutTables(): void {
  for (const el of document.querySelectorAll(".atable")) relayouts.get(el)?.();
}

if (typeof document !== "undefined" && document.fonts) {
  void document.fonts.ready.then(relayoutTables);
  document.fonts.addEventListener?.("loadingdone", relayoutTables);
}

const DEFAULT_COLS = 80;

/**
 * Replace a sanitized table with a text grid that re-lays itself out to the width of
 * its container. The original table stays in the DOM (visually hidden) for screen readers.
 */
export function asciiTable(table: HTMLTableElement): HTMLElement {
  const model = tableModel(table);
  const probe = h("span", { class: "at-probe", "aria-hidden": "true" }, "0".repeat(20));
  const grid = h("pre", { class: "at-grid", "aria-hidden": "true" });
  table.classList.add("sr-only");
  const wrap = h("div", { class: "atable" }, grid, probe, table);
  let last = "";
  const relayout = () => {
    const charW = probe.getBoundingClientRect().width / 20;
    const cols = charW > 0 && wrap.clientWidth > 0 ? Math.max(12, Math.floor(wrap.clientWidth / charW)) : DEFAULT_COLS;
    const key = `${cols}:${tableStyle}`;
    if (key === last) return;
    last = key;
    renderLines(grid, layoutTable(model, cols, tableStyle), model);
  };
  relayouts.set(wrap, relayout);
  relayout();
  if (typeof ResizeObserver !== "undefined") {
    observer ??= new ResizeObserver((entries) => {
      for (const e of entries) relayouts.get(e.target)?.();
    });
    observer.observe(wrap);
  }
  return wrap;
}
