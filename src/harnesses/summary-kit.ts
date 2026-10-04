/**
 * What a harness's `summarize` uses to read a transcript for the browser's index: a single pass that collects the
 * fields of a `SessionSummary` (see `sessions/summary.ts`), so each harness only says which lines carry which field.
 */
import { bumpOwn } from "../own-keys.js";

/** Kept per session: enough to recognise it and to search what was asked. */
const PROMPT_CHARS = 400;
const KEPT_PROMPTS = 8;
const SEARCH_CHARS = 6_000;
const REPLY_CHARS = 600;

export type Entry = Record<string, any>;

export const oneLine = (s: string, n = PROMPT_CHARS): string => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

export function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c: Entry) => c?.type === "text" && typeof c.text === "string")
    .map((c: Entry) => c.text)
    .join("\n");
}

export class Collector {
  prompts: string[] = [];
  models: string[] = [];
  tools: Record<string, number> = {};
  calls = 0;
  startedAt?: string;
  endedAt?: string;
  cwd?: string;
  branch?: string;
  title?: string;
  reply?: string;
  private searchLen = 0;
  search: string[] = [];
  private head: string[] = [];
  private tail: string[] = [];
  promptCount = 0;

  stamp(ts: unknown): void {
    if (typeof ts !== "string") return;
    this.startedAt ??= ts;
    this.endedAt = ts;
  }

  prompt(raw: string): void {
    const text = raw.replace(/<\/?pasted_content[^>]*>/g, "").trim();
    if (!text) return;
    this.promptCount++;
    const line = oneLine(text);
    if (this.head.length < KEPT_PROMPTS) this.head.push(line);
    else {
      this.tail.push(line);
      if (this.tail.length > KEPT_PROMPTS / 2) this.tail.shift();
    }
    if (this.searchLen < SEARCH_CHARS) {
      const t = oneLine(text, 600);
      this.search.push(t);
      this.searchLen += t.length;
    }
  }

  /** An assistant message's text; a message with none (only tool calls) leaves the last reply as it was. */
  say(content: unknown): void {
    const text = textOf(content).replace(/\s+/g, " ").trim();
    if (text) this.reply = text.length > REPLY_CHARS ? `${text.slice(0, REPLY_CHARS - 1)}…` : text;
  }

  model(m: unknown): void {
    if (typeof m === "string" && m && m !== "<synthetic>" && !this.models.includes(m)) this.models.push(m);
  }

  tool(name: unknown): void {
    if (typeof name === "string" && name) bumpOwn(this.tools, name);
  }

  get promptHead(): string[] {
    return this.head;
  }
  get promptTail(): string[] {
    return this.tail;
  }
  get first(): string | undefined {
    return this.head[0];
  }
  get last(): string | undefined {
    return this.tail.at(-1) ?? (this.head.length > 1 ? this.head.at(-1) : undefined);
  }
}

export function* lines(raw: string): Generator<string> {
  let pos = 0;
  while (pos < raw.length) {
    let end = raw.indexOf("\n", pos);
    if (end < 0) end = raw.length;
    if (end > pos) yield raw.slice(pos, end);
    pos = end + 1;
  }
}

export const parseLine = (line: string): Entry | undefined => {
  try {
    return JSON.parse(line);
  } catch {
    return undefined; // torn last line
  }
};

/** First 1.5 KB of a line: where `"type":…` and the start of `message.content` live. */
export const headOf = (line: string): string => (line.length > 1500 ? line.slice(0, 1500) : line);
