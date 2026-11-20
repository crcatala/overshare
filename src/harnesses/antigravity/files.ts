import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { listDir } from "../discovery.js";
import { maxSessionBytes } from "../limits.js";
import { lines, parseLine } from "../summary-kit.js";
import { getMessages, getNumber, getString, getAll, text } from "./protobuf.js";
import { withDatabase } from "./sqlite.js";

/**
 * Where Antigravity keeps conversations (docs/harnesses/antigravity.md). Each product has its own data folder; inside
 * one, a conversation is `brain/<id>/.system_generated/logs/transcript_full.jsonl`, with `conversations/<id>.db`
 * (SQLite) and `annotations/<id>.pbtxt` beside it.
 *
 * The root overshare is given is either one data folder (it has `brain/`) or a folder to look for them in: by default
 * the home folder, where every product's data folder is found at its known place.
 */

/** Data folders under a parent (home), as each product places them. `*` is one level of any folder. */
const KNOWN_FOLDERS = [
  ".gemini/antigravity",
  ".gemini/antigravity-ide",
  ".gemini/antigravity-cli",
  ".gemini/antigravity-acp",
  ".gemini/antigravity-backup",
  ".config/antigravity",
  // The ACP server T3 Code runs, one per installation hash.
  ".local/share/t3/userdata/providers/antigravity/*/antigravity-acp",
];

const isDataFolder = (dir: string): boolean => existsSync(join(dir, "brain"));

/** The data folders a root names: itself, or the known ones under it. */
export function dataFolders(root: string | undefined): string[] {
  if (!root) return [];
  if (isDataFolder(root)) return [root];
  const out: string[] = [];
  for (const pattern of KNOWN_FOLDERS) {
    let dirs = [root];
    for (const part of pattern.split("/")) dirs = part === "*" ? dirs.flatMap((d) => listDir(d).map((n) => join(d, n))) : dirs.map((d) => join(d, part));
    out.push(...dirs.filter(isDataFolder));
  }
  return out;
}

const TRANSCRIPTS = ["transcript_full.jsonl", "transcript.jsonl"];

/** Every conversation's transcript under a root (the full one, else the shortened one); conversations without one are left out. */
export function allTranscripts(root: string | undefined): string[] {
  return dataFolders(root).flatMap((data) =>
    listDir(join(data, "brain")).flatMap((id) => {
      const logs = join(data, "brain", id, ".system_generated", "logs");
      const file = TRANSCRIPTS.map((name) => join(logs, name)).find((f) => existsSync(f));
      return file ? [file] : [];
    }),
  );
}

/** The conversation id: the `brain/<id>` folder (the transcript's lines carry none). */
export function conversationId(file: string): string {
  const parts = resolve(file).split(/[\\/]/);
  const brain = parts.lastIndexOf("brain");
  return brain >= 0 && parts[brain + 1] ? parts[brain + 1]! : basename(file, ".jsonl");
}

/** The data folder a transcript belongs to (above `brain/<id>/.system_generated/logs/`). */
export function dataFolderOf(file: string): string | undefined {
  const parts = resolve(file).split(/[\\/]/);
  const brain = parts.lastIndexOf("brain");
  return brain > 0 ? parts.slice(0, brain).join("/") || "/" : undefined;
}

/** `brain/<id>/.system_generated/`, where shortened tool outputs are kept in full. */
const generatedOf = (file: string): string => dirname(dirname(resolve(file)));

/**
 * The transcript sits where Antigravity writes it (`brain/<id>/.system_generated/logs/<transcript>`). Only then is
 * anything read from the folders around it: a loose copy elsewhere must not pick up unrelated files beside it.
 */
function inConversationLayout(file: string): boolean {
  const parts = resolve(file).split(/[\\/]/);
  return parts.length >= 5 && TRANSCRIPTS.includes(parts.at(-1)!) && parts.at(-2) === "logs" && parts.at(-3) === ".system_generated" && parts.at(-5) === "brain";
}

export interface Workspace {
  /** The folder (from its `file://` URI). */
  path: string;
  /** `owner/repo`, when the folder is a git repository Antigravity recognised. */
  repo?: string;
  branch?: string;
}

/** What the conversation's own database adds to its transcript. */
export interface ConversationDb {
  workspaces: Workspace[];
  /** Each model response's tool calls, by step index: the call ids, in order (the transcript has none). */
  calls: Record<string, string[]>;
  /** The same calls' tool names, to check the ids belong to the calls the transcript lists. */
  callNames: Record<string, string[]>;
  /** The call each tool result answers, by step index. */
  answers: Record<string, string>;
  /** Each model response's usage as the database records it, by step index (thinking and reply split, cache writes). */
  usage: Record<string, DbUsage>;
  /** The base model of each model response (`gemini-4-neon`), by step index. */
  models: Record<string, string>;
  /** Steps the transcript leaves out (status 6, apparently cancelled), by step index, with the call each answered. */
  skipped: Record<string, { answers?: string }>;
}

/** `steps.metadata` field 9: 2 input, 3 output, 4 cache write, 5 cache read, 9 thinking output, 10 reply output. */
export interface DbUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  thinking: number;
}

const fromUri = (uri: string): string | undefined => {
  try {
    return uri.startsWith("file:") ? fileURLToPath(uri) : undefined;
  } catch {
    return undefined;
  }
};

/**
 * `trajectory_metadata_blob` (row `main`): field 1 is one workspace each (1 URI, 3 git with 1 `owner/repo`, 4
 * branch); field 7 the URIs alone, used when field 1 is missing.
 */
function workspacesOf(blob: Uint8Array): Workspace[] {
  const out: Workspace[] = [];
  for (const w of getMessages(blob, [1])) {
    const path = fromUri(getString(w, [1]) ?? "");
    if (!path) continue;
    const repo = getString(w, [3, 1]);
    const branch = getString(w, [4]);
    out.push({ path, ...(repo ? { repo } : {}), ...(branch ? { branch } : {}) });
  }
  if (out.length) return out;
  return getAll(blob, [7])
    .map((v) => fromUri(text(v) ?? ""))
    .filter((p): p is string => !!p)
    .map((path) => ({ path }));
}

const STEP_MODEL_RESPONSE = 15;
/** A step's status when the transcript leaves it out (seen on a step the agent did not run). */
const STATUS_SKIPPED = 6;

/** Read what the transcript lacks from `conversations/<id>.db`. Undefined when there is no database or it cannot be read. */
export function readConversationDb(path: string): ConversationDb | undefined {
  if (!existsSync(path)) return undefined;
  return withDatabase(path, (db) => {
    const meta = db.prepare("select data from trajectory_metadata_blob where id = 'main'").get()?.data;
    const workspaces = meta instanceof Uint8Array ? workspacesOf(meta) : [];
    const calls: Record<string, string[]> = {};
    const callNames: Record<string, string[]> = {};
    const answers: Record<string, string> = {};
    const usage: Record<string, DbUsage> = {};
    const skipped: Record<string, { answers?: string }> = {};
    const responseSteps: number[] = [];
    for (const row of db.prepare("select idx, step_type, status, metadata, step_payload from steps order by idx").all()) {
      const idx = row.idx;
      const payload = row.step_payload;
      if (typeof idx !== "number" || !(payload instanceof Uint8Array)) continue;
      if (row.step_type === STEP_MODEL_RESPONSE) {
        responseSteps.push(idx);
        const listed = getMessages(payload, [20, 7]);
        if (listed.length) {
          calls[idx] = listed.map((c) => getString(c, [1]) ?? "");
          callNames[idx] = listed.map((c) => getString(c, [2]) ?? "");
        }
        const u = row.metadata instanceof Uint8Array ? getMessages(row.metadata, [9])[0] : undefined;
        if (u) usage[idx] = { input: getNumber(u, [2]) ?? 0, output: getNumber(u, [3]) ?? 0, cacheWrite: getNumber(u, [4]) ?? 0, cacheRead: getNumber(u, [5]) ?? 0, thinking: getNumber(u, [9]) ?? 0 };
      } else {
        // A tool result names the call it answers (payload 5 -> 4 -> 1).
        const answer = getString(payload, [5, 4, 1]);
        if (answer) answers[idx] = answer;
      }
      if (row.status === STATUS_SKIPPED) skipped[idx] = { ...(answers[idx] ? { answers: answers[idx] } : {}) };
    }
    return { workspaces, calls, callNames, answers, usage, models: generationModels(db, responseSteps), skipped };
  });
}

/**
 * The base model of each model response, from `gen_metadata` (one row per generation): field 1 holds 19 (the model,
 * `gemini-4-neon`) and key/value pairs (20) with `last_step_index`, the step before the response it produced.
 */
function generationModels(db: { prepare(sql: string): { all(): Record<string, unknown>[] } }, responseSteps: readonly number[]): Record<string, string> {
  const out: Record<string, string> = {};
  let rows: Record<string, unknown>[];
  try {
    rows = db.prepare("select data from gen_metadata order by idx").all();
  } catch {
    return out;
  }
  for (const row of rows) {
    if (!(row.data instanceof Uint8Array)) continue;
    const gen = getMessages(row.data, [1])[0];
    const model = gen ? getString(gen, [19]) : undefined;
    const after = gen ? getMessages(gen, [20]).find((kv) => getString(kv, [1]) === "last_step_index") : undefined;
    const last = after ? Number(getString(after, [2])) : Number.NaN;
    const step = Number.isFinite(last) ? responseSteps.find((s) => s > last) : undefined;
    if (model && step !== undefined) out[step] = model;
  }
  return out;
}

/** `conversation_summaries.db`, a cache of every conversation's workspaces: only for a conversation without its own database. */
function summaryWorkspaces(data: string, id: string): Workspace[] {
  const path = join(data, "conversation_summaries.db");
  if (!existsSync(path)) return [];
  const raw = withDatabase(path, (db) => db.prepare("select workspace_uris from conversation_summaries where conversation_id = ?").get(id)?.workspace_uris);
  try {
    const uris: unknown = typeof raw === "string" ? JSON.parse(raw) : [];
    return (Array.isArray(uris) ? uris : []).map((u) => fromUri(String(u))).filter((p): p is string => !!p).map((path) => ({ path }));
  } catch {
    return [];
  }
}

const stamp = (path: string): string => {
  try {
    const st = statSync(path);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return "-";
  }
};

/** A conversation's database, read again only when it (or its write-ahead log) changes. */
const dbs = new Map<string, { stamp: string; db: ConversationDb | undefined }>();

export function conversationDb(file: string): ConversationDb | undefined {
  const data = dataFolderOf(file);
  if (!data) return undefined;
  const path = join(data, "conversations", `${conversationId(file)}.db`);
  const key = `${stamp(path)}|${stamp(`${path}-wal`)}`;
  const cached = dbs.get(path);
  if (cached?.stamp === key) return cached.db;
  const db = readConversationDb(path);
  dbs.set(path, { stamp: key, db });
  return db;
}

/** T3 Code adds its attachments folder as a workspace; it is not where the work happened. */
const isT3Attachments = (path: string): boolean => /[\\/]t3[\\/]userdata[\\/]attachments[\\/]?$/.test(path);

/** A conversation's workspaces: from its database, else from the summary cache. */
export function workspacesOfConversation(file: string): Workspace[] {
  const db = conversationDb(file);
  if (db?.workspaces.length) return db.workspaces;
  const data = dataFolderOf(file);
  return data ? summaryWorkspaces(data, conversationId(file)) : [];
}

/** The working directory: the first workspace with git information, else the first that is not T3's attachments. */
export function projectWorkspace(workspaces: readonly Workspace[]): Workspace | undefined {
  return workspaces.find((w) => w.repo) ?? workspaces.find((w) => !isT3Attachments(w.path)) ?? workspaces[0];
}

const sameDir = (a: string, b: string): boolean => resolve(a) === resolve(b);

/** Conversations under the root, optionally only those with `cwd` among their workspaces. */
export function listConversations(root: string, cwd?: string): string[] {
  const all = allTranscripts(root);
  if (cwd === undefined) return all;
  return all.filter((f) => workspacesOfConversation(f).some((w) => sameDir(w.path, cwd)));
}

/** `annotations/<id>.pbtxt`: `title:"…"` in protobuf text format. */
function annotationTitle(file: string): string | undefined {
  const data = dataFolderOf(file);
  if (!data) return undefined;
  try {
    const textFormat = readFileSync(join(data, "annotations", `${conversationId(file)}.pbtxt`), "utf8");
    const m = /^\s*title:\s*"((?:[^"\\]|\\.)*)"/m.exec(textFormat);
    if (!m) return undefined;
    const title = JSON.parse(`"${m[1]!.replace(/\\'/g, "'")}"`) as string;
    return title.trim() || undefined;
  } catch {
    return undefined;
  }
}

/** What the Antigravity adapter reads beside a transcript. */
export interface AntigravitySidecar {
  /** The conversation id, from the transcript's folder (its lines carry none). */
  id?: string;
  title?: string;
  /** Working directory and git branch, from the conversation's database. */
  workspaces?: Workspace[];
  calls?: Record<string, string[]>;
  callNames?: Record<string, string[]>;
  answers?: Record<string, string>;
  usage?: Record<string, DbUsage>;
  models?: Record<string, string>;
  skipped?: Record<string, { answers?: string }>;
  /**
   * Full outputs of tool results the transcript shortened, by step index (`steps/<n>/output.txt`); `null` when the
   * file is gone, so the shortened preview is dropped rather than shared.
   */
  outputs?: Record<string, string | null>;
}

/** The marker of a shortened tool result, and the step folder its full output is in. */
export const SHORTENED = /The tool's output was truncated due to being too long\. You can find the full output in a file at \S*?[\\/]steps[\\/](\d+)[\\/]output\.txt/;

/**
 * Full outputs of the shortened results in a transcript, read from this conversation's own `steps/` folder only:
 * the transcript must sit in its conversation layout, and each file, links resolved, must stay inside that folder.
 * Each is held to what is left of the size budget before it is read; one that does not fit (or is missing) is null.
 */
function shortenedOutputs(file: string): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return out;
  }
  const shortened: [number, string][] = [];
  for (const line of lines(raw)) {
    if (!line.includes("truncated due to being too long")) continue;
    const e = parseLine(line);
    const m = typeof e?.content === "string" ? SHORTENED.exec(e.content) : null;
    if (m && typeof e?.step_index === "number") shortened.push([e.step_index, m[1]!]);
  }
  if (!shortened.length) return out;
  let root: string | undefined;
  try {
    root = inConversationLayout(file) ? realpathSync(generatedOf(file)) : undefined;
  } catch {
    root = undefined;
  }
  let budget = maxSessionBytes() - raw.length;
  for (const [step, n] of shortened) {
    out[step] = null;
    if (!root) continue;
    try {
      const path = realpathSync(join(root, "steps", n, "output.txt"));
      if (!path.startsWith(`${root}/`)) continue;
      const size = statSync(path).size;
      if (size > budget) continue;
      budget -= size;
      out[step] = readFileSync(path, "utf8");
    } catch {
      // gone: the preview is dropped
    }
  }
  return out;
}

export function loadAntigravitySidecar(file: string, purpose: "parse" | "summary" = "parse"): AntigravitySidecar {
  const title = annotationTitle(file);
  const db = conversationDb(file);
  const workspaces = db?.workspaces.length ? db.workspaces : workspacesOfConversation(file);
  // The browser's index shows no tool output: only a share reads the full copies.
  const outputs = purpose === "summary" ? {} : shortenedOutputs(file);
  return {
    id: conversationId(file),
    ...(title ? { title } : {}),
    ...(workspaces.length ? { workspaces } : {}),
    ...(db ? { calls: db.calls, callNames: db.callNames, answers: db.answers, usage: db.usage, models: db.models, skipped: db.skipped } : {}),
    ...(Object.keys(outputs).length ? { outputs } : {}),
  };
}

/** Changes whenever the sidecar would: the database, its log, the annotation and the step outputs folder. */
export function antigravitySidecarKey(file: string): string {
  const data = dataFolderOf(file);
  if (!data) return "";
  const id = conversationId(file);
  const db = join(data, "conversations", `${id}.db`);
  return [stamp(db), stamp(`${db}-wal`), stamp(join(data, "annotations", `${id}.pbtxt`)), stamp(join(generatedOf(file), "steps"))].join("|");
}

/** Each data folder's login token (JSON), read for redaction only. */
export const oauthTokenFiles = (root: string): string[] => dataFolders(root).map((d) => join(d, "antigravity-oauth-token"));

/** Clear the in-process caches (tests). */
export function resetAntigravityCaches(): void {
  dbs.clear();
}
