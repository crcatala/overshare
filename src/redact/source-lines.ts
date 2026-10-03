/**
 * Where in the source transcript a value sits, so a suspicious or blocked finding can be followed to the line.
 *
 * The share is built from a projection of the transcript (steps merged, dropped and rewritten per mode), so a line
 * number cannot be read off the payload. Instead the value is looked for in the source itself, which gives the exact
 * line and needs no provenance carried through projection, redaction and capping; nothing here touches the payload.
 *
 * Both JSONL harnesses (Claude Code, pi) are line-delimited JSON, so a line is decoded and its strings and object
 * keys are matched: matching the raw line would miss any value that JSON escaped (quotes, newlines, `\u` sequences).
 * The value never arrives here. The caller passes a matcher over decoded text, built from a `SecretValue`.
 */

/** One transcript file: the session itself (no `name`) or a subagent transcript beside it. */
export interface SourceFile {
  /** Report-safe name (a `safeLabel`), shown with the line; absent for the session file, whose path the report prints. */
  name?: string;
  raw: string;
}

export interface SourceHit {
  file?: string;
  /** 1-based, as an editor counts: blank and unparseable lines are counted. */
  line: number;
}

export interface SourceLines {
  /** The first places the value occurs, in file order (session file first). */
  hits: SourceHit[];
  /** Every line it occurs on; more than `hits.length` when the list is capped. */
  total: number;
}

export type TextMatcher = (text: string) => boolean;

/** Looks a value up in the source by matcher; undefined when it is nowhere in it (e.g. it only arose from a transform). */
export type SourceLocator = (match: TextMatcher) => SourceLines | undefined;

const MAX_HITS = 5;

interface Indexed {
  file?: string;
  line: number;
  texts: string[];
}

/** Every string and object key of a decoded line. */
function collect(value: unknown, out: string[]): void {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) collect(v, out);
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      out.push(k);
      collect(v, out);
    }
  }
}

function index(files: readonly SourceFile[]): Indexed[] {
  const out: Indexed[] = [];
  for (const { name, raw } of files) {
    raw.split("\n").forEach((text, i) => {
      if (!text.trim()) return;
      const texts: string[] = [];
      try {
        collect(JSON.parse(text), texts);
      } catch {
        // A torn or foreign line is searched as it is.
        texts.push(text);
      }
      out.push({ ...(name !== undefined ? { file: name } : {}), line: i + 1, texts });
    });
  }
  return out;
}

/**
 * A locator over `files`. The decoded lines are built on the first lookup: a clean share (nearly all of them) never
 * looks anything up, so it never pays for the extra pass.
 */
export function sourceLocator(files: readonly SourceFile[]): SourceLocator {
  let lines: Indexed[] | undefined;
  return (match) => {
    lines ??= index(files);
    const hits: SourceHit[] = [];
    let total = 0;
    for (const l of lines) {
      if (!l.texts.some(match)) continue;
      total++;
      if (hits.length < MAX_HITS) hits.push({ ...(l.file !== undefined ? { file: l.file } : {}), line: l.line });
    }
    return total ? { hits, total } : undefined;
  };
}

/** `line 42`, `lines 42, 57 (+2 more)`, `agent-a1.jsonl line 9`; value-free, for the report and the browse dialog. */
export function formatSourceLines(source: SourceLines): string {
  const groups = new Map<string | undefined, number[]>();
  for (const h of source.hits) groups.set(h.file, [...(groups.get(h.file) ?? []), h.line]);
  const parts = [...groups].map(([file, nums]) => `${file ? `${file} ` : ""}${nums.length === 1 ? "line" : "lines"} ${nums.join(", ")}`);
  const more = source.total - source.hits.length;
  return `${parts.join("; ")}${more > 0 ? ` (+${more} more)` : ""}`;
}
