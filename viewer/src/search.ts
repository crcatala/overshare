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
  const input = step.action === "read" ? "" : strings(step.input).map((s) => (step.action === "edit" || step.action === "write" || step.action === "exec" ? s : relTo(cwd, s))).join("\n");
  return [field(step.name, [summary, input].filter(Boolean).join("\n")), field(`${step.name} output`, step.result?.text, "output")];
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
    const add = (d: SearchDoc | undefined) => d && docs.push(d);
    add(doc(turn.index, promptId(turn.index), promptFields(turn)));
    turn.steps.forEach((step, i) => add(doc(turn.index, stepId(turn.index, i), stepFields(step, cwd))));
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

const escape = (token: string) => token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

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

/** The line holding the most of the words (the first of those), or undefined when none holds any. */
function bestLine(lines: readonly string[], words: readonly string[]): string | undefined {
  let best: string | undefined;
  let most = 0;
  for (const line of lines) {
    const folded = fold(line);
    const n = words.filter((w) => folded.includes(w)).length;
    if (n > most) [best, most] = [line, n];
    if (most === words.length) break;
  }
  return best;
}

/**
 * A one-line excerpt around the first hit, about `width` characters, with the hits' ranges
 * in the excerpt. The excerpt comes from the line holding the most of the words, where the
 * words around them belong, and starts shortly before the first hit so it survives the
 * rail's line clamp. It is cut at word boundaries, with "…" where it was cut. `markdown`
 * drops the syntax.
 */
export function snippet(source: string, tokens: readonly string[], width = 80, markdown = false): { text: string; ranges: [number, number][] } {
  const words = tokens.filter((t) => t.length >= MIN_HIGHLIGHT);
  const pattern = words.length ? new RegExp(words.map(escape).join("|"), "iu") : undefined;
  const raw = source.split("\n");
  const lines = markdown ? raw.map(plainMarkdown) : raw;
  // A hit only the syntax held (a link's URL) is shown in the raw line.
  const text = (words.length ? (bestLine(lines, words) ?? bestLine(raw, words)) : undefined) ?? lines.find((l) => l.trim()) ?? "";
  const first = pattern ? text.search(pattern) : -1;
  const at = Math.max(0, first);
  let start = Math.max(0, at - Math.floor(width / 4));
  let end = Math.min(text.length, start + width);
  start = Math.max(0, Math.min(start, end - width));
  // Move the cuts to the nearest space inside the window, so no word is split.
  if (start > 0) {
    const space = text.slice(start, at).search(/\s/);
    if (space >= 0) start += space + 1;
  }
  if (end < text.length) {
    const space = text.slice(Math.max(at, start), end).search(/\s\S*$/);
    if (space > 0) end = Math.max(at, start) + space;
  }
  const body = text.slice(start, end).replace(/\s+/g, " ").trim();
  const out = `${start > 0 ? "…" : ""}${body}${end < text.length ? "…" : ""}`;
  return { text: out, ranges: hitRanges(out, words) };
}
