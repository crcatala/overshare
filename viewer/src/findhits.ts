/**
 * Outlines the words a rail filter matched, in the transcript entries a clicked row points
 * at. They are outlines, not a background, because some variants already tint their
 * blocks; and they stay until the filter changes or another row is clicked.
 *
 * Words are found in the entries' text nodes and wrapped in <mark>. The text itself does
 * not change, so layout, copy and search-in-page behave as before.
 */
import { hitRanges, MIN_HIGHLIGHT } from "./filter.ts";

/** A filter word in a long tool output can match thousands of times; stop somewhere useful. */
const MAX_MARKS = 200;

let marks: HTMLElement[] = [];

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

/** Drops every outline, restoring the text nodes as they were. */
export function clearHits(): void {
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
 * `pulseHits` starts their ripple once the scroll has arrived.
 */
export function showHits(ids: readonly string[], tokens: readonly string[]): void {
  clearHits();
  const words = tokens.filter((t) => t.length >= MIN_HIGHLIGHT);
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
