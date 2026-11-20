/**
 * Synthetic Antigravity data folders (ACP 1.5.x layout as T3 Code runs it), built in code from the shapes in
 * docs/harnesses/antigravity.md: a `transcript_full.jsonl`, the conversation's SQLite database with protobuf blobs,
 * an annotation, and the full outputs of shortened tool results. Nothing here comes from a real conversation.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

type Json = Record<string, unknown>;

/** Protobuf wire encoding: a message is a list of [field, value] (number = varint, string/bytes = length-delimited, array = submessage). */
export type Pb = [number, number | string | Uint8Array | Pb][];

function varint(n: number): number[] {
  const out: number[] = [];
  let v = n;
  do {
    let b = v % 128;
    v = Math.floor(v / 128);
    if (v > 0) b |= 0x80;
    out.push(b);
  } while (v > 0);
  return out;
}

export function encode(msg: Pb): Uint8Array {
  const bytes: number[] = [];
  for (const [field, value] of msg) {
    if (typeof value === "number") bytes.push(...varint(field * 8), ...varint(value));
    else {
      const body = typeof value === "string" ? new TextEncoder().encode(value) : value instanceof Uint8Array ? value : encode(value);
      bytes.push(...varint(field * 8 + 2), ...varint(body.length), ...body);
    }
  }
  return Uint8Array.from(bytes);
}

export interface Call {
  name: string;
  args: Json;
  /** Its result's content (a GENERIC step), unless `skipped` (a step the transcript left out). */
  result?: string;
  skipped?: boolean;
  status?: "DONE" | "RUNNING";
  media?: number;
}

export interface Workspace {
  path: string;
  repo?: string;
  branch?: string;
}

/** The wrapper Antigravity puts around what the user typed; `t3` adds T3 Code's instructions around a nested request. */
export function wrapPrompt(text: string, opts: { t3?: boolean; settings?: string[] } = {}): string {
  const request = opts.t3 ? `<t3_code_instructions>\nT3-INSTRUCTIONS-MARKER\n</t3_code_instructions>\n<user_request>\n${text}\n</user_request>\n<runtime_info>\nRUNTIME-MARKER\n</runtime_info>` : text;
  const settings = (opts.settings ?? []).map((s) => `\n<USER_SETTINGS_CHANGE>\n${s}\n</USER_SETTINGS_CHANGE>`).join("");
  return `<USER_REQUEST>\n${request}\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: 2026-01-01T10:00:00Z. ADDITIONAL-METADATA-MARKER\n</ADDITIONAL_METADATA>${settings}`;
}

export class AntigravityConversation {
  steps: Json[] = [];
  /** Database rows: step index, step type, status and payload. */
  dbSteps: { idx: number; type: number; status: number; payload: Pb }[] = [];
  /** Full outputs of shortened results, by step index (written to `steps/<n>/output.txt`). */
  outputs = new Map<number, string>();
  private idx = 0;
  private seconds = 0;
  private callSeq = 0;
  constructor(
    readonly id = "0a9e0000-1111-4222-8333-444455556666",
    readonly workspaces: Workspace[] = [{ path: "/home/tester/work/demo", repo: "tester/demo", branch: "main" }],
  ) {}

  private now(): string {
    this.seconds += 1;
    return new Date(Date.UTC(2026, 0, 1, 10, 0, this.seconds)).toISOString();
  }

  private step(type: string, source: string, fields: Json, status = "DONE"): number {
    const step_index = this.idx++;
    this.steps.push({ step_index, source, type, status, created_at: this.now(), ...fields });
    return step_index;
  }

  user(text: string, opts: { t3?: boolean; settings?: string[]; media?: number } = {}): this {
    const idx = this.step("USER_INPUT", "USER_EXPLICIT", { content: wrapPrompt(text, opts), ...(opts.media ? { media: Array.from({ length: opts.media }, (_, i) => ({ mime_type: "image/png", uri: `file:///x/media/step_${this.idx}_media_${i}.png` })) } : {}) });
    this.dbSteps.push({ idx, type: 14, status: 3, payload: [[1, 14]] });
    return this;
  }

  /** A model response: text, thinking, tool calls (each with its result step after it), usage. */
  respond(opts: { text?: string; thinking?: string; calls?: Call[]; input?: number | string; cacheRead?: number; output?: number; model?: string } = {}): this {
    const calls = opts.calls ?? [];
    const ids = calls.map(() => `call_${++this.callSeq}${"0".repeat(12)}`);
    const idx = this.step("PLANNER_RESPONSE", "MODEL", {
      model: opts.model ?? "gemini-4-neon-high",
      input_tokens: opts.input ?? 1_000,
      cache_read_tokens: opts.cacheRead ?? 0,
      output_tokens: opts.output ?? 50,
      ...(opts.text ? { content: opts.text } : {}),
      ...(opts.thinking ? { thinking: opts.thinking } : {}),
      ...(calls.length ? { tool_calls: calls.map((c) => ({ name: c.name, args: c.args })) } : {}),
    });
    this.dbSteps.push({ idx, type: 15, status: 3, payload: [[1, 15], [20, ids.map((id, i) => [7, [[1, id], [2, calls[i]!.name], [3, JSON.stringify(calls[i]!.args)]]] as [number, Pb])]] });
    calls.forEach((c, i) => {
      if (c.skipped) {
        // Cancelled (status 6): in the database, missing from the transcript.
        this.dbSteps.push({ idx: this.idx++, type: 132, status: 6, payload: [[1, 132], [5, [[4, [[1, ids[i]!]]]]]] });
        return;
      }
      const ridx = this.step("GENERIC", "MODEL", { content: `Created At: 2026-01-01T10:00:00Z\nCompleted At: 2026-01-01T10:00:01Z\n${c.result ?? ""}`, ...(c.media ? { media: Array.from({ length: c.media }, (_, m) => ({ mime_type: "image/png", uri: `file:///x/step_${this.idx}_media_${m}.png` })) } : {}) }, c.status ?? "DONE");
      this.dbSteps.push({ idx: ridx, type: 132, status: c.status === "RUNNING" ? 2 : 3, payload: [[1, 132], [5, [[4, [[1, ids[i]!]]]]]] });
    });
    return this;
  }

  /**
   * A result Antigravity shortened: the preview keeps the start and end with the middle cut, and the full output is in
   * `steps/<n>/output.txt`. Returns the step index the next result will have.
   */
  shortened(full: string, cut: [number, number]): string {
    const n = this.idx + 1;
    this.outputs.set(n, full);
    return `The tool's output was truncated due to being too long. You can find the full output in a file at file:///x/brain/${this.id}/.system_generated/steps/${n}/output.txt\nThe output:\n${full.slice(0, cut[0])}\n<truncated 12 lines>\n${full.slice(cut[1])}`;
  }

  system(inner: string): this {
    this.step("SYSTEM_MESSAGE", "SYSTEM", { content: `The following is a <SYSTEM_MESSAGE> not actually sent by the user. It is provided by the system as important information to pay attention to.\n\n<SYSTEM_MESSAGE>\n${inner}\n</SYSTEM_MESSAGE>` });
    return this;
  }

  error(message: string): this {
    this.step("ERROR_MESSAGE", "SYSTEM", { error: message, content: message });
    return this;
  }

  toJsonl(): string {
    return `${this.steps.map((s) => JSON.stringify(s)).join("\n")}\n`;
  }

  /** `trajectory_metadata_blob` row `main`: one field-1 message per workspace, and the URIs in field 7. */
  metadataBlob(): Uint8Array {
    const uri = (p: string) => pathToFileURL(p).href;
    return encode([
      ...this.workspaces.map((w): [number, Pb] => [1, [[1, uri(w.path)], ...(w.repo ? ([[3, [[1, w.repo], [2, `https://example.invalid/${w.repo}.git`]]]] as Pb) : []), ...(w.branch ? ([[4, w.branch]] as Pb) : [])]]),
      ...this.workspaces.map((w): [number, string] => [7, uri(w.path)]),
    ]);
  }

  /** Write the conversation into a data folder: transcript, database (unless `db: false`), annotation, outputs. */
  write(data: string, opts: { db?: boolean; title?: string; outputs?: boolean } = {}): string {
    const logs = join(data, "brain", this.id, ".system_generated", "logs");
    mkdirSync(logs, { recursive: true });
    const transcript = join(logs, "transcript_full.jsonl");
    writeFileSync(transcript, this.toJsonl());
    if (opts.outputs !== false) {
      for (const [n, full] of this.outputs) {
        const dir = join(data, "brain", this.id, ".system_generated", "steps", String(n));
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "output.txt"), full);
      }
    }
    if (opts.title !== undefined) {
      mkdirSync(join(data, "annotations"), { recursive: true });
      writeFileSync(join(data, "annotations", `${this.id}.pbtxt`), `title:${JSON.stringify(opts.title)}\n`);
    }
    if (opts.db !== false) {
      mkdirSync(join(data, "conversations"), { recursive: true });
      const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as { DatabaseSync: new (p: string) => { exec(s: string): void; prepare(s: string): { run(...a: unknown[]): void }; close(): void } };
      const db = new DatabaseSync(join(data, "conversations", `${this.id}.db`));
      db.exec("CREATE TABLE steps (idx integer, step_type integer NOT NULL DEFAULT 0, status integer NOT NULL DEFAULT 0, metadata blob, step_payload blob, PRIMARY KEY (idx))");
      db.exec('CREATE TABLE trajectory_metadata_blob (id text DEFAULT "main", data blob, PRIMARY KEY (id))');
      const insert = db.prepare("INSERT INTO steps (idx, step_type, status, step_payload) VALUES (?, ?, ?, ?)");
      for (const s of this.dbSteps) insert.run(s.idx, s.type, s.status, encode(s.payload));
      db.prepare("INSERT INTO trajectory_metadata_blob (id, data) VALUES ('main', ?)").run(this.metadataBlob());
      db.close();
    }
    return transcript;
  }
}
