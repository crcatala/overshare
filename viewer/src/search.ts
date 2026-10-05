/**
 * Full-text search for the contents rail. Pure data, no DOM: the index is built from the
 * session the viewer renders (already redacted, and projected to the current view), so a
 * result never points at text the view can't show.
 *
 * One document per transcript entry (a prompt or a step). Every word of the query has to
 * be in one entry, like the label filter requires one label: a snippet from that entry
 * can then show why it matched, and a click has one place to go. Tool output is indexed
 * but only searched on request, because words like "test" or "error" appear in most of it.
 */
import type { NormalizedSession, Step, ToolStep, Turn } from "../../src/schema.ts";
import { fold, hitRanges, matchesAll, MIN_HIGHLIGHT } from "./filter.ts";
import { promptId, relTo, stepId } from "./transcript.ts";

/** One piece of an entry's text, named for the rail ("prompt", "Bash", "Bash output"). */
export interface Field {
  source: string;
  text: string;
  folded: string;
  /** A tool's or subagent's result, searched only when output is included. */
  output?: boolean;
  /** Markdown (prompts, replies, thinking): its snippets drop the syntax. */
  markdown?: boolean;
}

export interface SearchDoc {
  turn: number;
  /** The transcript entry: the id the viewer jumps to and outlines hits in. */
  id: string;
  fields: Field[];
  /** The folded fields joined: without output, and with it. A token holds no spaces, so it never spans two fields. */
  inputs: string;
  all: string;
}

export interface SearchHit {
  doc: SearchDoc;
  /** The field with the most of the query's words, for the snippet. */
  field: Field;
}

const field = (source: string, text: string | undefined, kind?: "output" | "markdown"): Field | undefined =>
  text?.trim() ? { source, text, folded: fold(text), ...(kind ? { [kind]: true } : {}) } : undefined;

/** Every string inside a tool input: what its JSON view shows, without the keys and quoting. */
function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) strings(v, out);
  else if (value && typeof value === "object") for (const v of Object.values(value)) strings(v, out);
  return out;
}

/** A tool call's text as the transcript shows it: the summary line, then what opening it shows. */
function toolFields(step: ToolStep, cwd: string | undefined): (Field | undefined)[] {
  const summary = relTo(cwd, step.summary || "");
  // A read's input is the path (already the summary) plus offsets; everything else is shown in full.
  // The summary repeats the input: a command's first line, a file's path, a search's pattern
  // and path. Each is kept once, so a hit shows once.
  const all = step.action === "read" ? [] : strings(step.input).map((s) => relTo(cwd, s));
  const lead = all.some((s) => s.split("\n", 1)[0] === summary) ? [] : [summary];
  const inputs = lead.length ? all.filter((s) => s.includes("\n") || !summary.includes(s)) : all;
  return [field(step.name, [...lead, ...inputs].filter(Boolean).join("\n")), field(`${step.name} output`, step.result?.text, "output")];
}

function stepFields(step: Step, cwd: string | undefined): (Field | undefined)[] {
  switch (step.kind) {
    case "text":
      return [field("reply", step.text, "markdown")];
    case "thinking":
      return [field("thinking", step.text, "markdown")];
    case "tool":
      return toolFields(step, cwd);
    case "toolGroup":
      return [field("commands", step.commands.map((c) => relTo(cwd, c)).join("\n")), field("files", [...step.files.edited, ...step.files.written, ...step.files.read].map((f) => relTo(cwd, f)).join("\n"))];
    case "subagent":
      return [field(step.tool, [step.agents.join(", "), step.description].filter(Boolean).join("\n")), field(`${step.tool} output`, step.result?.text, "output")];
    case "event":
      return [field(step.event.replace("_", " "), [step.text, step.detail].filter(Boolean).join("\n"))];
    default:
      return []; // a kind from a newer format: drawn as a placeholder, so nothing to find in it
  }
}

function doc(turn: number, id: string, fields: (Field | undefined)[]): SearchDoc | undefined {
  const kept = fields.filter((f): f is Field => Boolean(f));
  if (!kept.length) return undefined;
  const inputs = kept.filter((f) => !f.output).map((f) => f.folded).join(" ");
  return { turn, id, fields: kept, inputs, all: kept.map((f) => f.folded).join(" ") };
}

function promptFields(turn: Turn): (Field | undefined)[] {
  const u = turn.user;
  if (!u) return [];
  const command = u.command ? `${u.command.name}${u.command.args ? ` ${u.command.args}` : ""}` : "";
  return [field("prompt", [command, u.text, u.expanded].filter(Boolean).join("\n"), "markdown")];
}

/** One document per prompt and step of the turns the transcript renders. Folds everything once: build it lazily. */
export function buildIndex(session: NormalizedSession): SearchDoc[] {
  const cwd = session.project?.cwd;
  const docs: SearchDoc[] = [];
  for (const turn of session.turns) {
    if (!turn.user && !turn.steps.length) continue;
    // An entry whose data isn't what its kind promises is drawn as a placeholder (transcript.ts), so it has nothing to find; the rest stay searchable.
    const add = (make: () => SearchDoc | undefined) => {
      try {
        const d = make();
        if (d) docs.push(d);
      } catch {}
    };
    add(() => doc(turn.index, promptId(turn.index), promptFields(turn)));
    turn.steps.forEach((step, i) => add(() => doc(turn.index, stepId(turn.index, i), stepFields(step, cwd))));
  }
  return docs;
}

/** The entries holding every token, in transcript order. `output` also searches tool results. */
export function search(docs: readonly SearchDoc[], tokens: readonly string[], output: boolean): SearchHit[] {
  if (!tokens.length) return [];
  const hits: SearchHit[] = [];
  for (const d of docs) {
    if (!matchesAll(output ? d.all : d.inputs, tokens)) continue;
    let best: Field | undefined;
    let most = 0;
    for (const f of d.fields) {
      if (f.output && !output) continue;
      const n = tokens.filter((t) => f.folded.includes(t)).length;
      if (n > most) [best, most] = [f, n];
    }
    if (best) hits.push({ doc: d, field: best });
  }
  return hits;
}

/** How many turns match only once tool output is searched too: the hint that offers it. */
export function outputOnlyTurns(docs: readonly SearchDoc[], tokens: readonly string[], matched: ReadonlySet<number>): number {
  const extra = new Set<number>();
  for (const d of docs) if (!matched.has(d.turn) && !extra.has(d.turn) && matchesAll(d.all, tokens)) extra.add(d.turn);
  return extra.size;
}


/** A markdown line as it reads: no emphasis or code marks, no heading or list markers, table cells split by "·". */
function plainMarkdown(line: string): string {
  if (/^\s*\|?\s*:?-{3,}/.test(line)) return "";
  return line
    .replace(/^\s*(#{1,6}\s+|>\s*|[-*+]\s+)/, "")
    .replace(/(\*\*|__|`)/g, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s*\||\|\s*$/g, "")
    .replace(/\s*\|\s*/g, " · ");
}

/** One stretch of text around one or more hits, with the hits' ranges in it. */
export interface Stretch {
  text: string;
  ranges: [number, number][];
}

/** The stretches to show, how many more hits the text holds past them, and how many it holds in all. */
export interface Excerpt {
  stretches: Stretch[];
  more: number;
  total: number;
}

/** Characters kept on each side of a hit: about half a line of the rail. */
const CONTEXT = 16;
/** Hits closer than CONTEXT join one stretch, up to this length; past it a new stretch starts. */
const MAX_STRETCH = 80;
/** Stretches shown per row; the rest are counted. */
const MAX_STRETCHES = 2;

/**
 * The hits in `source` with a little context each, compact enough for a rail row whatever
 * the text's length. Each hit keeps about CONTEXT characters on either side; a hit within
 * that reach of the previous one joins its stretch, so nearby hits read as one phrase.
 * Stretches stay on their line and are cut at word boundaries, with "…" where a line was
 * cut. `markdown` drops the syntax first (a hit only the syntax held, like a link's URL,
 * is shown from the raw text). Without a word long enough to find, the first line is shown.
 */
export function excerpt(source: string, tokens: readonly string[], opts: { markdown?: boolean; context?: number; max?: number } = {}): Excerpt {
  const context = opts.context ?? CONTEXT;
  const words = tokens.filter((t) => t.length >= MIN_HIGHLIGHT);
  let text = opts.markdown ? source.split("\n").map(plainMarkdown).join("\n") : source;
  let hits = hitRanges(text, words);
  if (!hits.length && opts.markdown) {
    text = source;
    hits = hitRanges(text, words);
  }
  if (!hits.length) {
    const line = (text.split("\n").find((l) => l.trim()) ?? "").replace(/\s+/g, " ").trim();
    const cut = 3 * context;
    return { stretches: [{ text: line.length > cut ? `${line.slice(0, cut - 1)}…` : line, ranges: [] }], more: 0, total: 0 };
  }

  const groups: { start: number; end: number; lineStart: number; lineEnd: number; first: number; last: number; hits: number }[] = [];
  for (const [s, e] of hits) {
    const prev = groups[groups.length - 1];
    const sameLine = prev !== undefined && s < prev.lineEnd;
    if (prev && sameLine && s <= prev.end && e + context - prev.start <= MAX_STRETCH) {
      prev.end = Math.min(prev.lineEnd, e + context);
      prev.last = e;
      prev.hits++;
      continue;
    }
    const lineStart = sameLine ? prev.lineStart : text.lastIndexOf("\n", s - 1) + 1;
    const newline = text.indexOf("\n", e);
    const lineEnd = sameLine ? prev.lineEnd : newline < 0 ? text.length : newline;
    // A stretch split for length starts where the previous one ended, so no text shows twice.
    const start = Math.max(lineStart, s - context, sameLine ? prev.end : 0);
    groups.push({ start, end: Math.min(lineEnd, e + context), lineStart, lineEnd, first: s, last: e, hits: 1 });
  }

  const stretch = (g: (typeof groups)[number]): Stretch => {
    let { start, end } = g;
    // Move the cuts to a space between the cut and the hits, so no word is split.
    if (start > g.lineStart) {
      const space = text.slice(start, g.first).search(/\s/);
      if (space >= 0) start += space + 1;
    }
    if (end < g.lineEnd) {
      const space = text.slice(g.last, end).search(/\s\S*$/);
      if (space >= 0) end = g.last + space;
    }
    const body = text.slice(start, end).replace(/\s+/g, " ").trim();
    const out = `${start > g.lineStart ? "…" : ""}${body}${end < g.lineEnd ? "…" : ""}`;
    return { text: out, ranges: hitRanges(out, words) };
  };
  // The same stretch twice (a line repeated in the text) says nothing new: shown once, not counted.
  const max = opts.max ?? MAX_STRETCHES;
  const stretches: Stretch[] = [];
  const seen = new Set<string>();
  let more = 0;
  for (const g of groups) {
    if (stretches.length >= max) {
      more += g.hits;
      continue;
    }
    const st = stretch(g);
    if (seen.has(st.text)) continue;
    seen.add(st.text);
    stretches.push(st);
  }
  return { stretches, more, total: hits.length };
}
