/**
 * A projected, redacted session as one markdown file (`overshare archive`). Browser-safe: no Node imports.
 *
 *   # <title>
 *   ## User (Turn N)        the prompt as plain text, escaped so markdown shows it as typed (`promptMarkdown`)
 *   ## Assistant (Turn N)   the model's markdown, its headings moved below this one (`assistantMarkdown`)
 *
 * The renderer only prints what the share mode kept; it never reaches past the projection. Tool lines are opt-in.
 */
import type { NormalizedSession, Step, Turn, UserPrompt } from "./schema.js";

export interface MarkdownOptions {
  /** Print a line per tool group, subagent launch and (full mode) tool call. */
  tools?: boolean;
  /** YAML frontmatter, written as given (see `frontmatter`). */
  frontmatter?: Record<string, FrontmatterValue>;
}

export type FrontmatterValue = string | number | boolean | string[] | { [key: string]: FrontmatterValue | undefined } | undefined;

export function renderMarkdown(session: NormalizedSession, opts: MarkdownOptions = {}): string {
  const out: string[] = [];
  if (opts.frontmatter) out.push(frontmatter(opts.frontmatter));
  out.push(`# ${inlineText(session.title?.split("\n", 1)[0]?.trim() || "Untitled session")}`);
  // Only there when the sharer opted in (full mode); fenced, since it is the harness's text, not a reply to render.
  if (session.systemPrompt?.length) out.push(["## System prompt", ...session.systemPrompt.map(fenced)].join("\n\n"));
  for (const turn of session.turns) {
    // Numbered as in `overshare browse` and the report's suspicious locations.
    const n = turn.index + 1;
    if (turn.user) out.push(userSection(turn.user, n));
    const assistant = assistantSection(turn, !!opts.tools);
    if (assistant) out.push(`## Assistant (Turn ${n})\n\n${assistant}`);
  }
  return `${out.join("\n\n")}\n`;
}

function userSection(user: UserPrompt, n: number): string {
  const command = user.command;
  const heading = `## User (Turn ${n})${command ? ` · ${codeSpan(command.name)}` : ""}`;
  // A command's text is `<name> <args>`; the name is in the heading.
  const parts = [promptMarkdown(command ? (command.args ?? "") : user.text)].filter(Boolean);
  if (user.images) parts.push(`_(${user.images} ${user.images === 1 ? "image" : "images"})_`);
  return [heading, ...parts].join("\n\n");
}

function assistantSection(turn: Turn, tools: boolean): string {
  let out = "";
  let lastWasTool = false;
  for (const step of turn.steps) {
    const block = stepBlock(step, tools);
    if (!block) continue;
    // Consecutive tool calls (full mode) are one list.
    const isTool = step.kind === "tool";
    out += out ? (isTool && lastWasTool ? "\n" : "\n\n") + block : block;
    lastWasTool = isTool;
  }
  return relevelHeadings(out, 3).trim();
}

function stepBlock(s: Step, tools: boolean): string | undefined {
  switch (s.kind) {
    case "text":
      // Closed per message, so a fence the model left open cannot swallow what follows it.
      return closeOpenFence(s.text.trim()) || undefined;
    case "event":
      return s.event === "compaction" ? "_— context compacted —_" : undefined;
    case "toolGroup":
      return tools ? toolGroupBlock(s) : undefined;
    case "subagent": {
      if (!tools) return;
      const who = s.agents.length ? s.agents.join(", ") : s.tool;
      return `_Subagent: ${inlineText(who)}${s.description ? ` — “${inlineText(s.description)}”` : ""}_`;
    }
    case "tool":
      return tools ? `- **${inlineText(s.name)}**${s.summary ? ` ${codeSpan(s.summary)}` : ""}${s.isError || s.result?.isError ? " _(error)_" : ""}` : undefined;
    default:
      // Thinking is never written, and a step kind from a newer format is left out rather than guessed at.
      return undefined;
  }
}

const MAX_FILES = 5;

function toolGroupBlock(s: Extract<Step, { kind: "toolGroup" }>): string | undefined {
  if (!s.total) return;
  const calls = s.calls.map((c) => `${inlineText(c.name)} ×${c.count}${c.errors ? ` (${c.errors} ${c.errors === 1 ? "error" : "errors"})` : ""}`).join(", ");
  const files = (verb: string, list: string[]) => {
    if (!list.length) return [];
    const shown = list.slice(0, MAX_FILES).map(codeSpan).join(", ");
    return [`${verb} ${shown}${list.length > MAX_FILES ? ` +${list.length - MAX_FILES} more` : ""}`];
  };
  const line = `_Tools: ${[calls, ...files("edited", s.files.edited), ...files("wrote", s.files.written)].join(" · ")}_`;
  // Commands are kept by brief mode only (minimal's groups have none).
  return [line, ...s.commands.map((c) => `- ${codeSpan(c)}`)].join("\n");
}

// --- Frontmatter -------------------------------------------------------------------------------------------------

/**
 * YAML frontmatter. Strings are written as JSON strings, which are valid YAML double-quoted scalars, so a title holding
 * `: "` or a newline cannot end the value or the block. Undefined values (and objects left empty) are dropped.
 */
export function frontmatter(fields: Record<string, FrontmatterValue>): string {
  return `---\n${yamlLines(fields, "").join("\n")}\n---`;
}

function yamlLines(fields: Record<string, FrontmatterValue>, indent: string): string[] {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) lines.push(`${indent}${key}: [${value.map((v) => JSON.stringify(v)).join(", ")}]`);
    else if (typeof value === "object") {
      const inner = yamlLines(value, `${indent}  `);
      if (inner.length) lines.push(`${indent}${key}:`, ...inner);
    } else lines.push(`${indent}${key}: ${typeof value === "string" ? JSON.stringify(value) : String(value)}`);
  }
  return lines;
}

// --- Fences --------------------------------------------------------------------------------------------------------

/** An opening code fence (CommonMark: up to 3 spaces, then 3+ backticks or tildes; a backtick fence's info has no backtick). */
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;

interface Fence {
  char: string;
  length: number;
}

function fenceOpen(line: string): Fence | undefined {
  const m = FENCE_OPEN.exec(line);
  if (!m) return;
  if (m[1]![0] === "`" && m[2]!.includes("`")) return;
  return { char: m[1]![0]!, length: m[1]!.length };
}

function closesFence(line: string, fence: Fence): boolean {
  const m = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
  return !!m && m[1]![0] === fence.char && m[1]!.length >= fence.length;
}

type Segment = { kind: "text"; lines: string[] } | { kind: "fence"; lines: string[]; fence: Fence; closed: boolean };

/** Split lines into fenced code blocks and the text between them. */
function segments(lines: string[]): Segment[] {
  const out: Segment[] = [];
  let text: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const fence = fenceOpen(lines[i]!);
    if (!fence) {
      text.push(lines[i]!);
      continue;
    }
    if (text.length) out.push({ kind: "text", lines: text });
    text = [];
    const block = [lines[i]!];
    let closed = false;
    for (i++; i < lines.length; i++) {
      block.push(lines[i]!);
      if (closesFence(lines[i]!, fence)) {
        closed = true;
        break;
      }
    }
    out.push({ kind: "fence", lines: block, fence, closed });
  }
  if (text.length) out.push({ kind: "text", lines: text });
  return out;
}

/** A fence that `text` cannot close: one backtick longer than its longest run of backticks, and at least three. */
export function fenceFor(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  return "`".repeat(Math.max(3, longest + 1));
}

/** `text` as a plain-text code block, whatever fences it holds. */
function fenced(text: string): string {
  const fence = fenceFor(text);
  return `${fence}text\n${text.replace(/\n+$/, "")}\n${fence}`;
}

/** Close a fenced block left open at the end of `text`. */
export function closeOpenFence(text: string): string {
  const segs = segments(text.split("\n"));
  const last = segs.at(-1);
  if (last?.kind !== "fence" || last.closed) return text;
  return `${text}\n${last.fence.char.repeat(last.fence.length)}`;
}

// --- Assistant text ------------------------------------------------------------------------------------------------

const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/;
/** Lines a setext underline cannot follow as paragraph text. */
const NOT_PARAGRAPH = /^(?: {0,3}(?:[-*+>]|\d{1,9}[.)]|#{1,6}(?:\s|$))| {4,}|\t)/;

interface Heading {
  /** Index of the first line (setext headings span the paragraph and the underline). */
  start: number;
  end: number;
  level: number;
  text: string;
}

function headingsIn(lines: string[]): Heading[] {
  const found: Heading[] = [];
  let para = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const atx = ATX.exec(line);
    if (atx) {
      found.push({ start: i, end: i, level: atx[1]!.length, text: (atx[2] ?? "").trim() });
      para = -1;
      continue;
    }
    const setext = SETEXT.exec(line);
    if (setext && para >= 0) {
      found.push({ start: para, end: i, level: setext[1]![0] === "=" ? 1 : 2, text: lines.slice(para, i).map((l) => l.trim()).join(" ") });
      para = -1;
      continue;
    }
    if (!line.trim()) para = -1;
    else if (para < 0 && !NOT_PARAGRAPH.test(line)) para = i;
    else if (NOT_PARAGRAPH.test(line)) para = -1;
  }
  return found;
}

/**
 * Move the headings of model-written markdown so the shallowest becomes `top`, keeping their relative depth (a message
 * using `##` and `###` gets H3 and H4 below the H2 role heading). A heading that would go past H6 becomes a bold line.
 * Setext headings are rewritten as ATX ones; nothing inside a code fence is touched.
 */
export function relevelHeadings(text: string, top: number): string {
  const segs = segments(text.split("\n"));
  const all = segs.flatMap((s) => (s.kind === "text" ? headingsIn(s.lines) : []));
  if (!all.length) return text;
  const shift = top - Math.min(...all.map((h) => h.level));
  return segs
    .flatMap((s) => {
      if (s.kind === "fence") return s.lines;
      const lines = [...s.lines];
      for (const h of headingsIn(s.lines).reverse()) {
        const level = h.level + shift;
        const line = level > 6 ? (h.text ? `**${h.text}**` : "") : `${"#".repeat(level)}${h.text ? ` ${h.text}` : ""}`;
        lines.splice(h.start, h.end - h.start + 1, line);
      }
      return lines;
    })
    .join("\n");
}

// --- User prompts --------------------------------------------------------------------------------------------------

/** A line markdown would read as a heading, a quote, a setext underline or a thematic break. */
const BLOCK_START = /^( {0,3})(#{1,6}(?=[ \t]|$)|>|=+[ \t]*$|-+[ \t]*$|(?:\*[ \t]*){3,}$|(?:_[ \t]*){3,}$)/;
const LIST_ITEM = /^ {0,3}(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/;
const INDENTED = /^(?: {4,}|\t)/;
const LINK_DEFINITION = /^( {0,3})\[(?=[^\]]*\]:)/;
const TABLE_DELIMITER = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;

/**
 * A prompt as markdown that shows what was typed. Prompts are plain text: rendered as markdown, `*` and `_` start
 * emphasis, `<Name>` disappears as HTML, `# ...` becomes a heading and single line breaks vanish. What the user
 * plainly meant as formatting (lists, links, inline code, fenced blocks, paired emphasis, tables) is kept; everything
 * else is escaped. Line breaks become hard breaks, and an indented block (a pasted log) becomes a fenced one.
 */
export function promptMarkdown(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").replace(/\s+$/, "").split("\n");
  const out: string[] = [];
  for (const seg of segments(lines)) {
    if (seg.kind === "fence") {
      out.push(...seg.lines);
      if (!seg.closed) out.push(seg.fence.char.repeat(seg.fence.length));
      continue;
    }
    out.push(...proseLines(seg.lines));
  }
  // Leading blank lines would otherwise survive as nothing at all.
  return out.join("\n").replace(/^\n+/, "");
}

type ProseBlock = { kind: "line"; text: string; table: boolean } | { kind: "code"; lines: string[] } | { kind: "blank" };

/** Lines of GFM tables (a header row, the delimiter row and the rows after it), which must stay one line each. */
function tableRows(lines: string[]): Set<number> {
  const rows = new Set<number>();
  for (let i = 1; i < lines.length; i++) {
    if (!TABLE_DELIMITER.test(lines[i]!) || !lines[i - 1]!.includes("|") || !lines[i]!.includes("|")) continue;
    rows.add(i - 1).add(i);
    for (let j = i + 1; j < lines.length && lines[j]!.trim() && lines[j]!.includes("|"); j++) rows.add(j);
  }
  return rows;
}

function proseLines(lines: string[]): string[] {
  const tables = tableRows(lines);
  // An indented run (other than a list item's continuation) becomes a code block; table rows only get inline escapes.
  const blocks: ProseBlock[] = [];
  let inList = false;
  // The content column of the list item the previous line belongs to, while no blank line has come between.
  let itemIndent: number | undefined;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim()) {
      blocks.push({ kind: "blank" });
      itemIndent = undefined;
      continue;
    }
    if (INDENTED.test(line) && !inList && !tables.has(i)) {
      const code = [line];
      while (i + 1 < lines.length && (INDENTED.test(lines[i + 1]!) || (!lines[i + 1]!.trim() && INDENTED.test(lines[i + 2] ?? "")))) code.push(lines[++i]!);
      blocks.push({ kind: "code", lines: code });
      continue;
    }
    const table = tables.has(i);
    // A line of `-` or `* * *` is a setext underline or a rule (escaped below), not a list item.
    const item = BLOCK_START.test(line) ? null : LIST_ITEM.exec(line);
    let text = table ? tableRowEscape(line) : escapeLine(line);
    if (item) {
      inList = true;
      itemIndent = contentColumn(line);
    } else if (!INDENTED.test(line)) {
      inList = false;
      // A plain line right after an item continues it. CommonMark allows it unindented ("lazy"), but parsers differ
      // (marked ends the item), so it is indented to the item's content.
      if (itemIndent !== undefined && !table) text = " ".repeat(itemIndent) + text;
    }
    blocks.push({ kind: "line", text, table });
  }

  const out: string[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]!;
    if (b.kind === "blank") {
      if (out.length && out.at(-1) !== "") out.push("");
      continue;
    }
    if (b.kind === "code") {
      const body = b.lines.join("\n");
      const fence = fenceFor(body);
      if (out.length && out.at(-1) !== "") out.push("");
      out.push(`${fence}text`, body, fence);
      if (blocks[i + 1] && blocks[i + 1]!.kind !== "blank") out.push("");
      continue;
    }
    const prev = blocks[i - 1];
    const next = blocks[i + 1];
    // A table is set apart by blank lines: a line of text right after it would be read as one more row.
    if (b.table && prev?.kind === "line" && !prev.table) out.push("");
    // A hard break only between two lines of one paragraph: before a block that interrupts it (a list item, a table),
    // a trailing `\` would end the paragraph and show as a literal backslash.
    const hardBreak = !b.table && next?.kind === "line" && !next.table && !LIST_ITEM.test(next.text);
    out.push(hardBreak ? `${b.text.replace(/[ \t]+$/, "")}\\` : b.text);
    if (b.table && next?.kind === "line" && !next.table) out.push("");
  }
  while (out.at(-1) === "") out.pop();
  return out;
}

/** Where a list item's content starts: after the marker and the 1-4 spaces that follow it (one, when there are more). */
function contentColumn(item: string): number {
  const m = /^( {0,3}(?:[-*+]|\d{1,9}[.)]))( *)/.exec(item)!;
  const spaces = m[2]!.length;
  return m[1]!.length + (spaces >= 1 && spaces <= 4 && spaces < item.length - m[1]!.length ? spaces : 1);
}

function escapeLine(line: string): string {
  // Before list items: a lone `-` under a line of text is a setext underline, and `* * *` is a rule, not a list.
  const block = BLOCK_START.exec(line);
  if (block) {
    const [, indent, marker] = block;
    return `${indent}\\${marker![0]}${inlineEscape(line.slice(indent!.length + 1))}`;
  }
  const item = LIST_ITEM.exec(line);
  // A list item's content starts a block of its own (`1. > x` is a quote in a list).
  if (item) return item[0] + escapeLine(line.slice(item[0].length));
  const def = LINK_DEFINITION.exec(line);
  if (def) return `${def[1]}\\[${inlineEscape(line.slice(def[0].length))}`;
  return inlineEscape(line);
}

/**
 * A table row keeps its pipes, but a row that starts like a block (`> a | b`, `- a | b`, `1. a | b`) would be read as
 * that block instead of the table's header or a row, so its first marker is escaped. The delimiter row is left as is.
 */
function tableRowEscape(line: string): string {
  if (TABLE_DELIMITER.test(line)) return inlineEscape(line);
  const item = LIST_ITEM.exec(line);
  if (item) {
    const [, indent, digits, marker] = /^( *)(\d*)(.)/.exec(item[0])!;
    return `${indent}${digits}\\${marker}${inlineEscape(line.slice(indent!.length + digits!.length + 1))}`;
  }
  return escapeLine(line);
}

/**
 * Escape what would turn plain text into markup within a line: backslashes before punctuation, entities, HTML-looking
 * `<`, and `*` / `_` that do not form a pair. Inline code spans are kept whole; a backtick run with no partner on the
 * line is escaped, so a span cannot reach into the next line.
 */
export function inlineEscape(line: string): string {
  let out = "";
  let rest = line;
  while (rest) {
    const open = /`+/.exec(rest);
    if (!open) {
      out += escapePlain(rest);
      break;
    }
    out += escapePlain(rest.slice(0, open.index));
    const run = open[0];
    const after = rest.slice(open.index + run.length);
    const close = new RegExp(`(?<!\`)${run}(?!\`)`).exec(after);
    if (close) {
      out += run + after.slice(0, close.index + run.length);
      rest = after.slice(close.index + run.length);
    } else {
      out += "\\`".repeat(run.length);
      rest = after;
    }
  }
  return out;
}

const PUNCT = /[!-/:-@[-`{-~]/;
const isSpace = (c: string | undefined) => c === undefined || /\s/.test(c);
const isPunct = (c: string | undefined) => c !== undefined && PUNCT.test(c);
const isWord = (c: string | undefined) => c !== undefined && /[\p{L}\p{N}]/u.test(c);

function escapePlain(text: string): string {
  let s = text
    .replace(/\\(?=[!-/:-@[-`{-~])/g, "\\\\")
    .replace(/&(?=#?[A-Za-z0-9]+;)/g, "\\&")
    .replace(/<(?=[A-Za-z/!?])/g, "\\<");
  s = escapeUnpaired(s, "*");
  s = escapeUnpaired(s, "_");
  // GFM strikes through `~a~` too, which "takes ~5 min, ~10 at most" would hit; only `~~a~~` is kept.
  s = escapeUnpaired(s, "~", 2);
  return s;
}

/**
 * Keep `*a*`, `**a**` (and `_a_`) that read as emphasis; escape every other run of `ch` (with `only`, also every run
 * of another length). A run opens when it is
 * followed by a non-space and preceded by a space, punctuation or the start; it closes the mirror way. `_` inside a
 * word is never emphasis in CommonMark, so it is left alone.
 */
function escapeUnpaired(s: string, ch: "*" | "_" | "~", only?: number): string {
  const runs: { start: number; length: number; open: boolean; close: boolean }[] = [];
  const re = { "*": /\*+/g, _: /_+/g, "~": /~+/g }[ch];
  for (const m of s.matchAll(re)) {
    const start = m.index!;
    // A character after an odd run of backslashes is escaped, not a delimiter.
    if (/(?:^|[^\\])(?:\\\\)*\\$/.test(s.slice(0, start))) continue;
    const before = s[start - 1];
    const after = s[start + m[0].length];
    if (ch === "_" && isWord(before) && isWord(after)) continue;
    const open = !isSpace(after) && (isSpace(before) || isPunct(before));
    const close = !isSpace(before) && (isSpace(after) || isPunct(after));
    runs.push({ start, length: m[0].length, open, close });
  }
  const keep = new Set<number>();
  for (let i = 0; i < runs.length; i++) {
    if (keep.has(i) || !runs[i]!.open || (only !== undefined && runs[i]!.length !== only)) continue;
    for (let j = i + 1; j < runs.length; j++) {
      if (keep.has(j)) continue;
      if (runs[j]!.close && runs[j]!.length === runs[i]!.length && runs[j]!.start > runs[i]!.start + runs[i]!.length) {
        keep.add(i).add(j);
        break;
      }
    }
  }
  let out = "";
  let last = 0;
  runs.forEach((r, i) => {
    out += s.slice(last, r.start) + (keep.has(i) ? ch.repeat(r.length) : `\\${ch}`.repeat(r.length));
    last = r.start + r.length;
  });
  return out + s.slice(last);
}

/** Text that goes inside generated markup (a title, a tool name, a description): one line, fully escaped. */
function inlineText(text: string): string {
  return text.replace(/\s+/g, " ").replace(/[\\`*_[\]<>#&|~]/g, "\\$&");
}

/** An inline code span that `text` cannot end early. */
function codeSpan(text: string): string {
  const one = text.replace(/\s+/g, " ");
  const longest = Math.max(0, ...[...one.matchAll(/`+/g)].map((m) => m[0].length));
  const ticks = "`".repeat(longest + 1);
  // CommonMark strips one space from each end of a span when both have one, and a backtick next to the fence would join it.
  const pad = /^[` ]|[` ]$/.test(one) && one.trim() ? " " : "";
  return `${ticks}${pad}${one}${pad}${ticks}`;
}
