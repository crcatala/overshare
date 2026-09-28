/** Small text helpers for tool output: previews and a line diff for edits. */

export function splitLines(text: string): string[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  while (lines.length > 1 && lines[lines.length - 1]!.trim() === "") lines.pop();
  return lines;
}

/** The first `n` lines, and how many more there are. */
export function preview(text: string, n: number): { lines: string[]; more: number } {
  const lines = splitLines(text);
  // Showing "+1 line" costs as much space as the line itself.
  if (lines.length <= n + 1) return { lines, more: 0 };
  return { lines: lines.slice(0, n), more: lines.length - n };
}

export function firstLine(text: string, max = 160): string {
  const line = text.trim().split("\n", 1)[0] ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export type DiffLine = { op: " " | "-" | "+"; text: string };

/**
 * Line diff of an edit's old/new text (LCS). Inputs are one edit's snippets, so this is
 * small; very large inputs fall back to "all removed, then all added".
 */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before === "" ? [] : before.replace(/\r\n?/g, "\n").split("\n");
  const b = after === "" ? [] : after.replace(/\r\n?/g, "\n").split("\n");
  // Trim the common prefix/suffix first: most edits touch a few lines of a larger snippet.
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const head = a.slice(0, pre).map((text) => ({ op: " " as const, text }));
  const tail = a.slice(a.length - suf).map((text) => ({ op: " " as const, text }));
  const x = a.slice(pre, a.length - suf);
  const y = b.slice(pre, b.length - suf);
  if (x.length * y.length > 250_000) {
    return [...head, ...x.map((text) => ({ op: "-" as const, text })), ...y.map((text) => ({ op: "+" as const, text })), ...tail];
  }
  const m = x.length;
  const n = y.length;
  const lcs: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) lcs[i]![j] = x[i] === y[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  }
  const mid: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < m || j < n) {
    if (i < m && j < n && x[i] === y[j]) {
      mid.push({ op: " ", text: x[i]! });
      i++;
      j++;
    } else if (j < n && (i === m || lcs[i]![j + 1]! >= lcs[i + 1]![j]!)) {
      mid.push({ op: "+", text: y[j]! });
      j++;
    } else {
      mid.push({ op: "-", text: x[i]! });
      i++;
    }
  }
  // Removals read better before additions within a changed hunk.
  for (let k = 0; k < mid.length; k++) {
    if (mid[k]!.op === " ") continue;
    let end = k;
    while (end < mid.length && mid[end]!.op !== " ") end++;
    const hunk = mid.slice(k, end);
    mid.splice(k, hunk.length, ...hunk.filter((d) => d.op === "-"), ...hunk.filter((d) => d.op === "+"));
    k = end;
  }
  return [...head, ...mid, ...tail];
}

/** Keep `context` unchanged lines around changes; collapse the rest to a marker. */
export function trimContext(diff: DiffLine[], context = 2): (DiffLine | { op: "…"; skipped: number })[] {
  const keep = diff.map(() => false);
  diff.forEach((d, i) => {
    if (d.op === " ") return;
    for (let k = Math.max(0, i - context); k <= Math.min(diff.length - 1, i + context); k++) keep[k] = true;
  });
  const out: (DiffLine | { op: "…"; skipped: number })[] = [];
  let skipped = 0;
  diff.forEach((d, i) => {
    if (keep[i]) {
      if (skipped) out.push({ op: "…", skipped });
      skipped = 0;
      out.push(d);
    } else skipped++;
  });
  if (skipped) out.push({ op: "…", skipped });
  return out;
}
