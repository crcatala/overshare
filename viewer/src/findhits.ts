/**
 * Outlines the words a rail filter matched, in the transcript entries a clicked row points
 * at. They are outlines, not a background, because some variants already tint their
 * blocks; and they stay until the filter changes or another row is clicked.
 *
 * Words are found in the entries' text nodes and wrapped in <mark>. The text itself does
 * not change, so layout, copy and search-in-page behave as before. Only visible text is
 * marked: a result found in a collapsed tool block's output asks for the block to be opened.
 */
import { fold, hitRanges, MIN_HIGHLIGHT } from "./filter.ts";

/** A filter word in a long tool output can match thousands of times; stop somewhere useful. */
const MAX_MARKS = 200;

let marks: HTMLElement[] = [];
/** What the outlines are for, so they can follow an entry that is opened or closed. */
let current: { ids: readonly string[]; tokens: readonly string[] } | undefined;

/** The entries to look in: an entry itself, or a turn's first entry (its prompt), like the jump beacon. */
function entriesOf(ids: readonly string[]): HTMLElement[] {
  const out: HTMLElement[] = [];
  for (const id of ids) {
    const el = document.getElementById(id);
    if (!el) continue;
    const entry = el.classList.contains("turn") ? el.querySelector<HTMLElement>(":scope > .entry") : el;
    if (entry) out.push(entry);
  }
  return out;
}

/**
 * Text nodes the reader sees, in order. Skipped: the gutter (decoration), `hidden` content,
 * and `.sr-only` copies, such as the real <table> behind each drawn ASCII table. Marks there
 * would be invisible and would use up the cap. (`aria-hidden` is not a reason to skip: the
 * drawn table itself is aria-hidden.)
 */
function textNodes(root: HTMLElement): Text[] {
  const nodes: Text[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement?.closest(".gut, .sr-only, [hidden]") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n as Text);
  return nodes;
}

/**
 * Opens an entry's collapsed parts (tool output, thinking, an expanded prompt, a written
 * file) when some of the words are not in the text it shows now, or when it shows fewer
 * than `count` hits. The words were found in the session data, so they are in there somewhere.
 */
function reveal(entry: HTMLElement, words: readonly string[], count = 0): void {
  const nodes = textNodes(entry);
  const seen = fold(nodes.map((n) => n.data).join(" "));
  const shown = count ? nodes.reduce((n, node) => n + hitRanges(node.data, words).length, 0) : 0;
  if (words.every((w) => seen.includes(w)) && shown >= count) return;
  for (const b of entry.querySelectorAll<HTMLButtonElement>('button.tline[aria-expanded="false"]')) b.click();
}

/** Drops every outline, restoring the text nodes as they were. */
export function clearHits(): void {
  current = undefined;
  unmark();
}

function unmark(): void {
  const parents = new Set<Node>();
  for (const mark of marks) {
    const parent = mark.parentNode;
    if (!parent) continue; // its entry was re-rendered away
    mark.replaceWith(document.createTextNode(mark.textContent ?? ""));
    parents.add(parent);
  }
  for (const p of parents) p.normalize();
  marks = [];
}

/**
 * Replaces any earlier outlines with the tokens' matches inside the entries `ids` name.
 * `reveal` first opens an entry whose visible text lacks some of the words, or holds fewer
 * than `count` hits. `pulseHits` starts their ripple once the scroll has arrived.
 */
export function showHits(ids: readonly string[], tokens: readonly string[], opts: { reveal?: boolean; count?: number } = {}): void {
  clearHits();
  const words = tokens.filter((t) => t.length >= MIN_HIGHLIGHT);
  // Set after revealing: opening an entry asks for a refresh, and there is nothing to refresh yet.
  if (opts.reveal) for (const entry of entriesOf(ids)) reveal(entry, words, opts.count);
  current = { ids, tokens };
  mark(ids, words);
}

/** Puts the current outlines back where the text now is, after an entry was opened or closed. */
export function refreshHits(): void {
  if (!current) return;
  unmark();
  mark(current.ids, current.tokens.filter((t) => t.length >= MIN_HIGHLIGHT));
}

function mark(ids: readonly string[], words: readonly string[]): void {
  if (!words.length) return;
  for (const entry of entriesOf(ids)) {
    for (const node of textNodes(entry)) {
      const room = MAX_MARKS - marks.length;
      if (room <= 0) return;
      // A single text node (a long paragraph, tool output) can hold thousands of matches, so
      // the cap applies to the ranges, not only between nodes.
      const ranges = hitRanges(node.data, words).slice(0, room);
      if (!ranges.length) continue;
      // Wrap from the last range back: each split leaves the text before it in `node`, so the
      // earlier offsets stay valid.
      const found: HTMLElement[] = [];
      for (let i = ranges.length - 1; i >= 0; i--) {
        const [start, end] = ranges[i]!;
        const hit = node.splitText(start);
        hit.splitText(end - start);
        const mark = document.createElement("mark");
        mark.className = "find-hit";
        hit.replaceWith(mark);
        mark.append(hit);
        found.unshift(mark);
      }
      marks.push(...found);
    }
  }
}

/** Starts the pulse on the current outlines (the same ripple the jump beacon makes). */
export function pulseHits(): void {
  for (const mark of marks) mark.classList.add("is-new");
}
