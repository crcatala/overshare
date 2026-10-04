/**
 * Cheap, single-pass session summaries for browsing (no NormalizedSession, no redaction, no cost).
 *
 * The index has to cover hundreds of files (some 30 MB), so this reads each transcript once, line by
 * line, and only JSON.parses the lines that can contribute: prompts, assistant messages (model, tool
 * names) and titles. Tool results (the bulk of most files) are skipped after a prefix check. Exact
 * cost, redaction findings and the full transcript come later, on demand, from the real pipeline.
 */
import { readFileSync } from "node:fs";
import { HARNESSES } from "../harnesses/index.js";
import { projectNameFromCwd } from "../harnesses/shared.js";
import { Collector, oneLine } from "../harnesses/summary-kit.js";
import { stripControls } from "../sanitize.js";
import type { HarnessName } from "../schema.js";
import { guessBranch } from "./branch.js";

export interface SessionSummary {
  harness: HarnessName;
  id: string;
  path: string;
  mtimeMs: number;
  size: number;
  cwd?: string;
  project?: string;
  branch?: string;
  /** `branch` was not recorded in the transcript but worked out from the repo's reflog (see branch.ts): a best guess. */
  branchGuess?: true;
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
  /** The last thing the assistant said in words (tool-only turns do not count), whitespace collapsed and cut; for the preview. */
  lastReply?: string;
  /** First and last few prompts, each truncated; what the preview shows. */
  promptHead: string[];
  promptTail: string[];
  /** Lower-cased title + project + prompt text for substring search (capped). */
  searchText: string;
  /** Set only on the stat-only placeholder row the browser shows before the file is read; never in the cache. */
  pending?: true;
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
    lastReply: clean(s.lastReply),
    promptHead: s.promptHead.map(stripControls),
    promptTail: s.promptTail.map(stripControls),
    searchText: stripControls(s.searchText),
  };
}

export function summarizeRaw(ref: SummarizeInput, raw: string): SessionSummary {
  const c = new Collector();
  HARNESSES[ref.harness].summarize(raw, c);
  const project = projectNameFromCwd(c.cwd);
  // Without a recorded title, name the session after what was asked; a bare slash command ("/model") says little.
  const asked = c.promptHead.find((p) => !p.startsWith("/")) ?? c.first;
  // Raw prompt text, cut at 80: local display only (the list, the preview, the cache file), never published. The share
  // title is derived again from the redacted prompt in `prepareShare` (ass-ahh1); do not feed this one into a share.
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
    subagents: HARNESSES[ref.harness].subagents?.count(ref.path, ref.id) ?? 0,
    worker: /^subagent-worker/.test(c.title ?? ""),
    firstPrompt: c.first,
    lastPrompt: c.last ?? c.first,
    lastReply: c.reply,
    promptHead: c.promptHead,
    promptTail: c.promptTail,
    searchText: [title, project, c.branch, c.models.join(" "), ...c.search].filter(Boolean).join("\n").toLowerCase(),
  });
}

/** A session whose transcript names no branch gets the repo's best guess, marked as one (it is searchable like a recorded branch). */
export function withBranchGuess(s: SessionSummary): SessionSummary {
  if (s.branch || !s.cwd) return s;
  const branch = guessBranch(s.cwd, s.endedAt ? Date.parse(s.endedAt) : s.mtimeMs);
  return branch ? { ...s, branch, branchGuess: true, searchText: `${s.searchText}\n${branch.toLowerCase()}` } : s;
}

export function summarizeFile(ref: SummarizeInput): SessionSummary {
  return withBranchGuess(summarizeRaw(ref, readFileSync(ref.path, "utf8")));
}
