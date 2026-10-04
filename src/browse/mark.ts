/**
 * Search highlighting for lines that are already styled: the words of a search get an amber background wherever they
 * occur, and everything else about the line (colours, bold, a diff's tint, a selected row) is left as it was.
 *
 * The line is matched as the user sees it, with escape sequences stripped, so no offsets have to be carried from the
 * source text through markdown, wrapping and syntax colouring.
 */
import { hitRanges, MIN_HIGHLIGHT } from "../sessions/query.js";

/** CSI (colours and the like), OSC (hyperlinks) and APC (cursor markers): zero-width, never matched against. */
const SEQUENCE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b_[^\x07\x1b]*(?:\x07|\x1b\\)/g;

/** A fixed pair, so a hit reads the same on a light and a dark terminal; 22 drops dim/bold, which would blur dark-on-amber. */
export const HIT_ON = "\x1b[22;38;5;16;48;5;179m";

/** The colours and weight a line has set at some point: what to put back when a hit ends. */
interface Pen {
  fg?: string;
  bg?: string;
  bold: boolean;
  dim: boolean;
}

/** Fold one SGR sequence (`\x1b[...m`) into the pen. */
function feed(pen: Pen, seq: string): void {
  if (!seq.endsWith("m") || !seq.startsWith("\x1b[")) return;
  const params = seq.slice(2, -1).split(";");
  for (let i = 0; i < params.length; i++) {
    const p = params[i]!;
    if (p === "" || p === "0") Object.assign(pen, { fg: undefined, bg: undefined, bold: false, dim: false });
    else if (p === "1") pen.bold = true;
    else if (p === "2") pen.dim = true;
    else if (p === "22") pen.bold = pen.dim = false;
    else if (p === "39") pen.fg = undefined;
    else if (p === "49") pen.bg = undefined;
    else if ((p >= "30" && p <= "37") || (p >= "90" && p <= "97")) pen.fg = p;
    else if ((p >= "40" && p <= "47") || (p >= "100" && p <= "107")) pen.bg = p;
    else if (p === "38" || p === "48") {
      // 38;5;n or 38;2;r;g;b: the colour is the parameters that follow.
      const length = params[i + 1] === "5" ? 3 : params[i + 1] === "2" ? 5 : 1;
      const colour = params.slice(i, i + length).join(";");
      if (p === "38") pen.fg = colour;
      else pen.bg = colour;
      i += length - 1;
    } else if (p.startsWith("38:")) pen.fg = p;
    else if (p.startsWith("48:")) pen.bg = p;
  }
}

/**
 * The reset after a hit. The background goes back through its own sequence (`49` when there was none), and never in a
 * combined one: a selected row re-applies its tint after every `\x1b[49m` (see `st.sel`).
 */
const restore = (pen: Pen): string => `${pen.fg ? `\x1b[${pen.fg}m` : "\x1b[39m"}${pen.bg ? `\x1b[${pen.bg}m` : "\x1b[49m"}${pen.bold ? "\x1b[1m" : ""}${pen.dim ? "\x1b[2m" : ""}`;

export interface Marked {
  line: string;
  /** How many separate stretches were highlighted. */
  hits: number;
}

/**
 * `line` with the words highlighted. `from` is the first visible column that may be marked: a row's own marker and
 * turn number come before it and are not part of what was searched.
 */
export function markLine(line: string, words: readonly string[], from = 0): Marked {
  if (!line || !words.some((w) => w.length >= MIN_HIGHLIGHT)) return { line, hits: 0 };
  const parts: { seq: boolean; text: string }[] = [];
  let plain = "";
  let at = 0;
  for (const m of line.matchAll(SEQUENCE)) {
    if (m.index > at) parts.push({ seq: false, text: line.slice(at, m.index) });
    parts.push({ seq: true, text: m[0] });
    at = m.index + m[0].length;
  }
  if (at < line.length) parts.push({ seq: false, text: line.slice(at) });
  for (const p of parts) if (!p.seq) plain += p.text;
  const ranges = hitRanges(plain.slice(from), words).map(([s, e]): [number, number] => [s + from, e + from]);
  if (!ranges.length) return { line, hits: 0 };

  const pen: Pen = { bold: false, dim: false };
  let out = "";
  let pos = 0; // visible characters emitted so far
  let r = 0;
  let inHit = false;
  for (const p of parts) {
    if (p.seq) {
      out += p.text;
      feed(pen, p.text);
      // The hit's colours win over any the text sets in the middle of it.
      if (inHit) out += HIT_ON;
      continue;
    }
    let i = 0;
    while (i < p.text.length) {
      const range = ranges[r];
      if (!range) {
        out += p.text.slice(i);
        break;
      }
      const edge = (inHit ? range[1] : range[0]) - (pos + i); // characters until the next change, from here
      const left = p.text.length - i;
      // A hit that ends with this piece is closed now; one that starts with the next piece is opened there.
      if (edge > left || (edge === left && !inHit)) {
        out += p.text.slice(i);
        break;
      }
      out += p.text.slice(i, i + edge);
      i += edge;
      if (inHit) {
        out += restore(pen);
        inHit = false;
        r++;
      } else {
        out += HIT_ON;
        inHit = true;
      }
    }
    pos += p.text.length;
  }
  if (inHit) out += restore(pen);
  return { line: out, hits: ranges.length };
}

/** The visible text of a styled line. */
export const unstyled = (line: string): string => line.replace(SEQUENCE, "");

/**
 * One line of `text` about `width` characters long around its first hit, cut at spaces with "…" where text was left
 * out. Undefined when the words are not in it (or are all too short to find).
 */
export function snippet(text: string, words: readonly string[], width: number): string | undefined {
  const flat = text.replace(/\s+/g, " ").trim();
  const hits = hitRanges(flat, words);
  const first = hits[0];
  if (!first) return undefined;
  if (flat.length <= width) return flat;
  let start = Math.max(0, first[0] - Math.floor(width / 4));
  let end = Math.min(flat.length, start + width);
  if (start > 0) {
    const space = flat.indexOf(" ", start);
    if (space >= 0 && space < first[0]) start = space + 1;
  }
  if (end < flat.length) {
    const space = flat.lastIndexOf(" ", end);
    if (space > Math.max(first[1], start)) end = space;
  }
  return `${start > 0 ? "…" : ""}${flat.slice(start, end)}${end < flat.length ? "…" : ""}`;
}

/** The words of free text, lower-case and distinct: what the viewer's own search box holds. */
export const splitWords = (text: string): string[] => [...new Set(text.toLowerCase().split(/\s+/).filter(Boolean))];
