/**
 * The viewer's right pane: one message drawn for reading, as styled lines of exactly the pane's width or less.
 *
 *   assistant   markdown (headings, lists, tables, quotes, code fences highlighted) through pi-tui's renderer
 *   user        the text as typed, wrapped: a prompt is not markdown, and rendering it would eat its `*` and `_`
 *   thinking    dim
 *   tool        the formatted `blocks` the worker cut the call into: the command as shell, an edit as a diff, a written
 *               file as code, anything else as its JSON input, then the result (see `toolBlocks` in job.ts)
 *   other       the plain body, wrapped
 *
 * An item with no `blocks` and no special kind falls back to the plain body, which is also what `y` copies.
 */
import { Markdown, type MarkdownTheme } from "@earendil-works/pi-tui";
import { highlight } from "./highlight.js";
import { fit, st, wrap } from "./kit.js";
import type { ViewBlock, ViewItem } from "./source.js";

const markdownTheme: MarkdownTheme = {
  heading: (s) => st.bold(st.cyan(s)),
  link: st.blue,
  linkUrl: st.dim,
  code: (s) => `\x1b[38;5;180m${s}\x1b[39m`,
  codeBlock: (s) => s,
  codeBlockBorder: st.gray,
  quote: st.dim,
  quoteBorder: st.gray,
  hr: st.gray,
  listBullet: st.cyan,
  bold: st.bold,
  italic: (s) => `\x1b[3m${s}\x1b[23m`,
  strikethrough: (s) => `\x1b[9m${s}\x1b[29m`,
  underline: (s) => `\x1b[4m${s}\x1b[24m`,
  highlightCode: (code, lang) => highlight(code, lang),
};

/** Markdown as lines no wider than `width`. */
export function markdown(text: string, width: number): string[] {
  return new Markdown(text, 0, 0, markdownTheme).render(width).map((l) => l.replace(/\s+$/, ""));
}

const GUTTER = st.gray("▏");
/** A background that runs the full width of a diff line, dark red and dark green. */
const bg = { del: (s: string) => `\x1b[48;5;52m${s}\x1b[49m`, add: (s: string) => `\x1b[48;5;22m${s}\x1b[49m` };

/** Lines of code with a gutter bar, wrapped (not cut) to the width. */
function codeLines(text: string, lang: string | undefined, width: number): string[] {
  const inner = Math.max(1, width - 2);
  return highlight(text, lang).flatMap((l) => (l === "" ? [GUTTER] : wrap(l, inner).map((p) => `${GUTTER} ${p}`)));
}

type Op = { op: " " | "-" | "+"; line: string };

/** A line diff by longest common subsequence; what is too big for that is shown as all removed, then all added. */
export function diffLines(oldText: string, newText: string): Op[] {
  const a = oldText.split("\n");
  const b = newText.split("\n");
  const n = a.length;
  const m = b.length;
  if (n * m > 160_000) return [...a.map((line): Op => ({ op: "-", line })), ...b.map((line): Op => ({ op: "+", line }))];
  // lcs[i][j]: length of the common subsequence of a[i..] and b[j..]
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) ops.push({ op: " ", line: a[i++]! }), j++;
    else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) ops.push({ op: "-", line: a[i++]! });
    else ops.push({ op: "+", line: b[j++]! });
  }
  while (i < n) ops.push({ op: "-", line: a[i++]! });
  while (j < m) ops.push({ op: "+", line: b[j++]! });
  return ops;
}

/** Long runs of unchanged lines collapse to "⋯ n unchanged lines", keeping this many at each side. */
const CONTEXT = 2;

/** `ops` with each long run of unchanged lines replaced by a count (`skipped`) between its first and last few. */
function collapse(ops: Op[]): Array<Op | { skipped: number }> {
  const out: Array<Op | { skipped: number }> = [];
  for (let i = 0; i < ops.length; ) {
    if (ops[i]!.op !== " ") {
      out.push(ops[i++]!);
      continue;
    }
    let end = i;
    while (end < ops.length && ops[end]!.op === " ") end++;
    const run = ops.slice(i, end);
    if (run.length > CONTEXT * 2 + 1) out.push(...run.slice(0, CONTEXT), { skipped: run.length - CONTEXT * 2 }, ...run.slice(-CONTEXT));
    else out.push(...run);
    i = end;
  }
  return out;
}

function diffBlock(path: string | undefined, edits: Array<{ old: string; new: string }>, width: number, lang: string | undefined): string[] {
  let added = 0;
  let removed = 0;
  const body: string[] = [];
  edits.forEach((e, k) => {
    if (k > 0) body.push(st.gray("  ⋯"));
    for (const o of collapse(diffLines(e.old, e.new))) {
      if ("skipped" in o) {
        body.push(st.gray(`  ⋯ ${o.skipped} unchanged lines`));
        continue;
      }
      if (o.op === "+") added++;
      if (o.op === "-") removed++;
      const mark = o.op === "+" ? st.green("+") : o.op === "-" ? st.red("-") : " ";
      // Changed lines are plain text on a tint: a code colour's own reset would cut the tint short.
      const shade = o.op === "+" ? bg.add : o.op === "-" ? bg.del : undefined;
      const text = shade ? o.line : (highlight(o.line, lang)[0] ?? "");
      wrap(text === "" ? " " : text, Math.max(1, width - 2)).forEach((part, n) => {
        const line = `${n === 0 ? mark : " "} ${part}`;
        body.push(shade ? shade(fit(line, width)) : line);
      });
    }
  });
  // Wrapped, never cut: a long path would otherwise lose its end, which is the file name, and the counts after it.
  return [...wrap(`${st.bold(path ?? "(file)")}  ${st.green(`+${added}`)} ${st.red(`−${removed}`)}`, width), ...body];
}

function blockLines(b: ViewBlock, width: number): string[] {
  switch (b.type) {
    case "markdown":
      return markdown(b.text, width);
    case "text":
      return b.text.split("\n").flatMap((l) => (l ? wrap(b.style === "error" ? st.red(l) : b.style === "dim" ? st.dim(l) : l, width) : [""]));
    case "label":
      return wrap(b.style === "error" ? st.red(`✗ ${b.text}`) : st.bold(st.cyan(b.text)), width);
    case "code":
      return codeLines(b.text, b.lang, width);
    case "edit": {
      const lang = /\.([A-Za-z0-9]+)$/.exec(b.path ?? "")?.[1];
      return diffBlock(b.path, b.edits, width, lang);
    }
  }
}

/** The pane's lines for `item`, wrapped to `width`. A blank line separates blocks. */
export function renderItem(item: ViewItem, width: number): string[] {
  if (item.blocks?.length) {
    const lines: string[] = [];
    item.blocks.forEach((b, i) => {
      // A label belongs to what follows it, so no blank line between them.
      if (i > 0 && item.blocks![i - 1]!.type !== "label") lines.push("");
      lines.push(...blockLines(b, width));
    });
    return lines;
  }
  if (item.kind === "assistant") return markdown(item.body, width);
  const dimmed = item.kind === "thinking" || item.kind === "tool";
  return item.body.split("\n").flatMap((l) => (l ? wrap(dimmed ? st.gray(l) : l, width) : [""]));
}
