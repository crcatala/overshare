/**
 * Cheap, single-pass session summaries for browsing (no NormalizedSession, no redaction, no cost).
 *
 * The index has to cover hundreds of files (some 30 MB), so this reads each transcript once, line by
 * line, and only JSON.parses the lines that can contribute: prompts, assistant messages (model, tool
 * names) and titles. Tool results (the bulk of most files) are skipped after a prefix check. Exact
 * cost, redaction findings and the full transcript come later, on demand, from the real pipeline.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { projectNameFromCwd, stripInjectedContext } from "../adapters/shared.js";
import { stripControls } from "../sanitize.js";
import type { HarnessName } from "../schema.js";

/** Kept per session: enough to recognise it and to search what was asked. */
const PROMPT_CHARS = 400;
const KEPT_PROMPTS = 8;
const SEARCH_CHARS = 6_000;

export interface SessionSummary {
  harness: HarnessName;
  id: string;
  path: string;
  mtimeMs: number;
  size: number;
  cwd?: string;
  project?: string;
  branch?: string;
  title?: string;
  startedAt?: string;
  endedAt?: string;
  models: string[];
  /** Authored prompts (slash commands count, harness-generated lines do not). */
  prompts: number;
  /** Model calls (assistant messages). */
  calls: number;
  /** Tool calls by tool name. */
  tools: Record<string, number>;
  /** Number of subagent transcripts next to a Claude session. */
  subagents: number;
  /** A session a subagent ran in (pi names these `subagent-worker-…`): rarely worth sharing on its own. */
  worker: boolean;
  firstPrompt?: string;
  lastPrompt?: string;
  /** First and last few prompts, each truncated; what the preview shows. */
  promptHead: string[];
  promptTail: string[];
  /** Lower-cased title + project + prompt text for substring search (capped). */
  searchText: string;
}

type Entry = Record<string, any>;

const oneLine = (s: string, n = PROMPT_CHARS): string => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c: Entry) => c?.type === "text" && typeof c.text === "string")
    .map((c: Entry) => c.text)
    .join("\n");
}

class Collector {
  prompts: string[] = [];
  models: string[] = [];
  tools: Record<string, number> = {};
  calls = 0;
  startedAt?: string;
  endedAt?: string;
  cwd?: string;
  branch?: string;
  title?: string;
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

  model(m: unknown): void {
    if (typeof m === "string" && m && m !== "<synthetic>" && !this.models.includes(m)) this.models.push(m);
  }

  tool(name: unknown): void {
    if (typeof name === "string" && name) this.tools[name] = (this.tools[name] ?? 0) + 1;
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

function* lines(raw: string): Generator<string> {
  let pos = 0;
  while (pos < raw.length) {
    let end = raw.indexOf("\n", pos);
    if (end < 0) end = raw.length;
    if (end > pos) yield raw.slice(pos, end);
    pos = end + 1;
  }
}

const parse = (line: string): Entry | undefined => {
  try {
    return JSON.parse(line);
  } catch {
    return undefined; // torn last line
  }
};

/** First 1.5 KB of a line: where `"type":…` and the start of `message.content` live. */
const headOf = (line: string): string => (line.length > 1500 ? line.slice(0, 1500) : line);

function summarizeClaude(raw: string, c: Collector): void {
  // A reply is written as several lines with the same message id; count each id once.
  const seenCalls = new Set<string>();
  let pendingCommand: string | undefined;
  for (const line of lines(raw)) {
    const head = headOf(line);
    // Bookkeeping lines (`{"type":"ai-title",…}`, modes, snapshots) lead with `type`; messages lead with `parentUuid`.
    if (head.startsWith('{"type":"') && !head.startsWith('{"type":"user","') && !head.startsWith('{"type":"assistant","')) {
      if (head.startsWith('{"type":"ai-title"')) {
        const e = parse(line);
        if (typeof e?.aiTitle === "string" && e.aiTitle) c.title = e.aiTitle;
      } else if (head.startsWith('{"type":"custom-title"')) {
        const e = parse(line);
        if (typeof e?.customTitle === "string" && e.customTitle) c.title = e.customTitle;
      }
      continue;
    }
    // Assistant lines lead with `message:{model,…}`; user lines carry `message:{role:"user"}`.
    const isAssistant = head.includes('"message":{"model"') || head.includes('"role":"assistant"');
    const isUser = !isAssistant && head.includes('"message":{"role":"user"');
    if (!isUser && !isAssistant) continue;
    if (head.includes('"isSidechain":true')) continue;
    if (isUser && head.includes('"type":"tool_result"')) {
      // Tool results are the bulk of a transcript and carry nothing we index.
      c.stamp(/"timestamp":"([^"]+)"/.exec(line.slice(-400))?.[1]);
      continue;
    }
    const e = parse(line);
    if (!e) continue;
    c.stamp(e.timestamp);
    if (typeof e.cwd === "string") c.cwd ??= e.cwd;
    if (typeof e.gitBranch === "string" && e.gitBranch !== "HEAD") c.branch = e.gitBranch;

    if (isAssistant) {
      const msg = e.message ?? {};
      c.model(msg.model);
      const id = msg.id ?? e.uuid;
      if (msg.model !== "<synthetic>" && id && !seenCalls.has(id)) {
        seenCalls.add(id);
        c.calls++;
      }
      for (const block of Array.isArray(msg.content) ? msg.content : []) if (block?.type === "tool_use") c.tool(block.name);
      continue;
    }

    if (e.isMeta || e.isCompactSummary) continue;
    const origin = e.origin;
    if (origin && typeof origin === "object" && origin.kind !== "human") continue;
    const text = textOf(e.message?.content);
    const name = /<command-name>([\s\S]*?)<\/command-name>/.exec(text)?.[1]?.trim();
    if (name) {
      const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1]?.trim();
      pendingCommand = `${name.startsWith("/") ? name : `/${name}`}${args ? ` ${args}` : ""}`;
      c.prompt(pendingCommand);
      continue;
    }
    if (text.includes("<local-command-stdout>") || /^\[Request interrupted by user/.test(text.trim())) continue;
    const clean = stripInjectedContext(text);
    if (!clean) continue;
    // A command's expansion follows it as a meta line (skipped above); a prompt typed after it stands alone.
    c.prompt(clean);
  }
}

function summarizePi(raw: string, c: Collector): void {
  for (const line of lines(raw)) {
    const head = headOf(line);
    // pi writes `type` first on every line.
    if (head.startsWith('{"type":"message"')) {
      if (head.includes('"role":"toolResult"')) {
        c.stamp(/"timestamp":"([^"]+)"/.exec(head)?.[1]);
        continue;
      }
      const e = parse(line);
      if (!e) continue;
      c.stamp(e.timestamp);
      const msg = e.message ?? {};
      if (msg.role === "user") {
        const text = textOf(msg.content).trim();
        if (text) c.prompt(text);
      } else if (msg.role === "assistant") {
        c.model(msg.model);
        c.calls++;
        for (const block of Array.isArray(msg.content) ? msg.content : []) if (block?.type === "toolCall") c.tool(block.name);
      }
    } else if (head.startsWith('{"type":"session_info"')) {
      const e = parse(line);
      if (typeof e?.name === "string" && e.name) c.title = e.name;
    } else if (head.startsWith('{"type":"session"')) {
      const e = parse(line);
      if (e) {
        c.stamp(e.timestamp);
        if (typeof e.cwd === "string") c.cwd = e.cwd;
      }
    } else if (head.startsWith('{"type":"model_change"')) {
      c.model(parse(line)?.modelId);
    }
  }
}

function subagentCount(path: string, id: string): number {
  const dir = join(dirname(path), id, "subagents");
  if (!existsSync(dir)) return 0;
  try {
    return readdirSync(dir).filter((f) => f.endsWith(".jsonl")).length;
  } catch {
    return 0;
  }
}

export interface SummarizeInput {
  harness: HarnessName;
  id: string;
  path: string;
  mtimeMs: number;
  size: number;
}

/** Strip terminal control sequences from every text field: transcripts are untrusted and these are printed. */
function sanitized(s: SessionSummary): SessionSummary {
  const clean = (v: string | undefined): string | undefined => (v === undefined ? v : stripControls(v));
  return {
    ...s,
    cwd: clean(s.cwd),
    project: clean(s.project),
    branch: clean(s.branch),
    title: clean(s.title),
    models: s.models.map(stripControls),
    tools: Object.fromEntries(Object.entries(s.tools).map(([name, n]) => [stripControls(name), n])),
    firstPrompt: clean(s.firstPrompt),
    lastPrompt: clean(s.lastPrompt),
    promptHead: s.promptHead.map(stripControls),
    promptTail: s.promptTail.map(stripControls),
    searchText: stripControls(s.searchText),
  };
}

export function summarizeRaw(ref: SummarizeInput, raw: string): SessionSummary {
  const c = new Collector();
  if (ref.harness === "claude-code") summarizeClaude(raw, c);
  else summarizePi(raw, c);
  const project = projectNameFromCwd(c.cwd);
  // Without a recorded title, name the session after what was asked; a bare slash command ("/model") says little.
  const asked = c.promptHead.find((p) => !p.startsWith("/")) ?? c.first;
  const title = c.title ?? (asked ? oneLine(asked, 80) : undefined);
  return sanitized({
    harness: ref.harness,
    id: ref.id,
    path: ref.path,
    mtimeMs: ref.mtimeMs,
    size: ref.size,
    cwd: c.cwd,
    project,
    branch: c.branch,
    title,
    startedAt: c.startedAt,
    endedAt: c.endedAt,
    models: c.models,
    prompts: c.promptCount,
    calls: c.calls,
    tools: c.tools,
    subagents: ref.harness === "claude-code" ? subagentCount(ref.path, ref.id) : 0,
    worker: /^subagent-worker/.test(c.title ?? ""),
    firstPrompt: c.first,
    lastPrompt: c.last ?? c.first,
    promptHead: c.promptHead,
    promptTail: c.promptTail,
    searchText: [title, project, c.branch, c.models.join(" "), ...c.search].filter(Boolean).join("\n").toLowerCase(),
  });
}

export function summarizeFile(ref: SummarizeInput): SessionSummary {
  return summarizeRaw(ref, readFileSync(ref.path, "utf8"));
}
