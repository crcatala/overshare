/**
 * The normalized, harness-agnostic session format ("overshare/1").
 *
 * Adapters convert each harness's native transcript into this shape; redaction,
 * mode projection, publishing and the viewer only ever see this shape. This file
 * is shared with the browser viewer, so it must stay free of Node imports.
 *
 * Evolving it: shares outlive the code that wrote them, and the viewer is always the latest.
 *   - Adding an optional field, or a new step kind, is compatible: don't bump the version. Older viewers
 *     skip what they don't know (an unknown step kind shows as a placeholder), so a new field must be
 *     optional and a viewer must read it only if present.
 *   - Removing, renaming or changing the meaning of a field is breaking: bump SCHEMA_VERSION and add a
 *     migration from the old version in viewer/src/compat.ts. tests/fixtures/shares/README.md has the steps.
 */

import type { HarnessName } from "./harnesses/meta.js";

export const SCHEMA_VERSION = "overshare/1" as const;

export type ShareMode = "full" | "brief" | "minimal" | "prompts";
export const SHARE_MODES: readonly ShareMode[] = ["full", "brief", "minimal", "prompts"];

export type { HarnessName };

/** Local-only pi extension entry; its payload is never copied into a share. */
export const PI_INPUT_PROVENANCE_TYPE = "overshare:authored-input";

export interface Usage {
  /** Uncached prompt tokens. */
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Reasoning/thinking tokens; a subset of `output` for the harnesses we support. */
  reasoning: number;
  /** Part of `cacheWrite` billed at the 1-hour rate (Anthropic); the rest is the 5-minute rate. */
  cacheWrite1h?: number;
  /** USD: recorded by the harness per response, or estimated at list price (see `SessionStats.costSource`). */
  cost?: number;
}

/** Why a model call happened, when it was not an ordinary assistant turn. */
export type ResponsePurpose = "compaction" | "summary" | "tool" | "cache-warm" | "background";

/**
 * A call that re-processed context the previous call could have read from cache (see `src/cache.ts`).
 * `miss`: unexplained, or after an idle gap. `rebuild`: first call after a compaction (expected).
 * `model-switch`: first call on another model, whose cache starts empty (expected).
 */
export type CacheEventKind = "miss" | "rebuild" | "model-switch";

export interface CacheEvent {
  kind: CacheEventKind;
  /** Tokens this call had to re-process (write or read uncached) that the previous call's context could have read from cache. */
  recached: number;
  /** Time since the previous model call, when both have timestamps. */
  gapMs?: number;
  /** The gap is longer than the cache lifetime this session's writes use (1 hour or 5 minutes): the likely cause. */
  idle?: true;
  /** Estimated USD over what reading those tokens from cache would have cost; absent when the rate is unknown. */
  cost?: number;
}

/** Token usage for one model API response (one assistant message). */
export interface ResponseUsage {
  id: string;
  turn: number;
  model?: string;
  timestamp?: string;
  usage: Usage;
  /** Set for calls made by the harness itself (compaction, cache keep-alive, ...) rather than by the conversation. */
  purpose?: ResponsePurpose;
  /** Inherited from a parent session's history (pi forks copy it); not spend of this session. */
  inherited?: true;
  /** Set when this call re-processed context it could have read from cache. */
  cacheEvent?: CacheEvent;
}

/** USD per million tokens, as recorded by the harness for a model. */
export interface TokenRates {
  input: number;
  cacheRead: number;
  cacheWrite?: number;
}

/** Prompt cache behaviour over a session's own model calls (Claude Code's `/usage` "Prompt cache (main)" line). */
export interface CacheSummary {
  /** Model calls whose provider reports prompt caching (calls made by the harness itself are left out). */
  requests: number;
  /** Share of those calls' prompt tokens read from cache, 0-100. */
  cachedPct: number;
  misses: number;
  rebuilds: number;
  modelSwitches: number;
  /** Tokens re-processed by the flagged calls. */
  recached: number;
  /** Estimated extra USD of the unexpected misses (not rebuilds or model switches); a lower bound when `extraCostPartial`. */
  extraCost?: number;
  extraCostPartial?: true;
}

/** Usage summed over a set of model calls. */
export interface UsageTotals {
  responses: number;
  tokens: Usage;
  cost?: number;
  /** Some calls had no cost (unknown model price, or none recorded), so `cost` undercounts. */
  costPartial?: boolean;
}

/**
 * Usage of the subagents a session launched (Claude Code: read from their own transcript files). Numbers and
 * model ids only, no text, so share modes cannot leak anything through it. `responses` counts their model calls.
 */
export interface SubagentTotals extends UsageTotals {
  /** Subagent files counted; a nested or resumed agent is one file. */
  agents: number;
  byModel: Record<string, UsageTotals>;
}

/** Subagent usage; everything in it is outside `SessionStats.tokens` and `cost`, which cover the main conversation. */
export interface SubagentUsageStats extends SubagentTotals {
  /** Subagents that no step on the exported branch launched (a rewound branch, a forked skill, an unknown layout): real spend, kept apart and not in the figures above. */
  unlinked?: SubagentTotals;
}

export interface SessionStats {
  turns: number;
  userPrompts: number;
  responses: number;
  toolCalls: number;
  /** Tool call counts by tool name, including subagent tools. */
  tools: Record<string, number>;
  toolErrors: number;
  thinking: { blocks: number; chars: number; tokens: number };
  subagents: number;
  compactions: number;
  files: { read: number; edited: number; written: number };
  tokens: Usage;
  /** Largest single-response prompt (input + cacheRead + cacheWrite). */
  peakContext: number;
  /** Session cost in USD, covering the model calls on the exported branch. Lower bound when `costPartial`. */
  cost?: number;
  /**
   * `per-response`: recorded by the harness (pi). `estimated`: computed from tokens at list price (Claude Code).
   */
  costSource?: "per-response" | "estimated";
  /** Some calls had no recorded or estimable cost (unknown model), so `cost` undercounts. */
  costPartial?: boolean;
  /** Usage in the file that is not on the exported branch (abandoned branches); not included above. */
  otherBranches?: UsageTotals;
  /** Usage inherited from a parent session (forks); not included above. */
  inherited?: UsageTotals;
  /**
   * Usage of the subagents launched on the exported branch, read from the subagent transcripts (Claude Code);
   * not included in `tokens` or `cost`. Absent when the transcripts were not available or there were none.
   * Computed on the full session, so share modes do not change it. (`subagents` above is the launch count.)
   */
  subagentUsage?: SubagentUsageStats;
  /**
   * Prompt cache summary; absent when no call reports caching.
   * Computed on the full session, so share modes do not change it.
   */
  cache?: CacheSummary;
  /**
   * Per-model prices recorded by the harness (pi records cost per call), so a cache miss can be
   * priced. Adapter input to `computeStats`; Claude Code has none and uses the price table.
   */
  rates?: Record<string, TokenRates>;
}

export interface RedactionSummary {
  total: number;
  byCategory: Record<string, number>;
  /** Entry kinds dropped wholesale before redaction (system prompts, attachments, ...). */
  dropped: Record<string, number>;
}

export interface NormalizedSession {
  schema: typeof SCHEMA_VERSION;
  mode: ShareMode;
  title?: string;
  harness: { name: HarnessName; version?: string; formatVersion?: number };
  source: { sessionId: string; leafId?: string };
  project?: { cwd?: string; name?: string; branch?: string };
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  models: string[];
  stats: SessionStats;
  responses: ResponseUsage[];
  turns: Turn[];
  redaction?: RedactionSummary;
  generator?: { name: string; version: string; sharedAt: string };
}

export interface UserPrompt {
  text: string;
  /** For pi, true only when pre-expansion input was bound to this native message. Missing means unverified. */
  authored?: boolean;
  /** Present when the prompt was a slash command / skill invocation. */
  command?: { name: string; args?: string };
  /** Prompt text a command expanded into (full mode only). */
  expanded?: string;
  images?: number;
}

/** Numeric-only activity retained when the turn's work is omitted. File counts are unique per action. */
export interface TurnActivity {
  toolCalls: number;
  toolErrors: number;
  files: { read: number; edited: number; written: number };
}

export interface Turn {
  index: number;
  timestamp?: string;
  user?: UserPrompt;
  /** Captured before projection, so stepping down does not lose counts. */
  activity?: TurnActivity;
  steps: Step[];
}

interface StepBase {
  id: string;
  timestamp?: string;
  /** The API response this step belongs to (links to `responses`). */
  responseId?: string;
}

export interface TextStep extends StepBase {
  kind: "text";
  text: string;
  model?: string;
}

export interface ThinkingStep extends StepBase {
  kind: "thinking";
  /** Thinking text, when the harness stored it and the mode keeps it. */
  text?: string;
  chars: number;
  blocks: number;
  /** Reasoning tokens reported for the response(s) this thinking came from. */
  tokens?: number;
}

export type ToolAction = "read" | "edit" | "write" | "search" | "exec" | "web" | "other";

export interface ToolResult {
  text: string;
  isError?: boolean;
  images?: number;
  truncatedFrom?: number;
}

export interface ToolStep extends StepBase {
  kind: "tool";
  name: string;
  action: ToolAction;
  /** One-line human summary, e.g. the first line of a bash command or a file path. */
  summary: string;
  files?: string[];
  input?: unknown;
  result?: ToolResult;
  isError?: boolean;
}

export interface ToolGroupStep extends StepBase {
  kind: "toolGroup";
  calls: { name: string; count: number; errors: number }[];
  total: number;
  files: { read: string[]; edited: string[]; written: string[] };
  /** One-line summaries of exec-style calls (commands). */
  commands: string[];
  responseIds: string[];
  thinking?: { blocks: number; chars: number; tokens: number };
}

export interface SubagentUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  /** Part of `cacheWrite` billed at the 1-hour rate. */
  cacheWrite1h?: number;
  cost?: number;
  /** Model calls. */
  turns?: number;
  toolUses?: number;
  durationMs?: number;
  totalTokens?: number;
  /** Models the subagent's calls ran on. */
  models?: string[];
  /** Agents folded into these figures beyond the launched one (nested subagents). */
  nested?: number;
}

export interface SubagentStep extends StepBase {
  kind: "subagent";
  tool: string;
  agents: string[];
  description?: string;
  mode?: string;
  async?: boolean;
  isError?: boolean;
  usage?: SubagentUsage;
  result?: ToolResult;
}

export type EventKind =
  | "model_change"
  | "thinking_level"
  | "compaction"
  | "command"
  | "skill"
  | "subagent_notice"
  | "interrupted"
  | "error";

export interface EventStep extends StepBase {
  kind: "event";
  event: EventKind;
  text: string;
  detail?: string;
}

export type Step = TextStep | ThinkingStep | ToolStep | ToolGroupStep | SubagentStep | EventStep;

export function emptyUsage(): Usage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
}

export function addUsage(a: Usage, b: Usage): Usage {
  const out: Usage = {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    reasoning: a.reasoning + b.reasoning,
  };
  if (a.cacheWrite1h !== undefined || b.cacheWrite1h !== undefined) out.cacheWrite1h = (a.cacheWrite1h ?? 0) + (b.cacheWrite1h ?? 0);
  if (a.cost !== undefined || b.cost !== undefined) out.cost = (a.cost ?? 0) + (b.cost ?? 0);
  return out;
}

/** Sum a set of model calls; undefined when there are none. `cost` is present only if some call has one. */
export function totalsOf(list: ResponseUsage[]): UsageTotals | undefined {
  if (list.length === 0) return undefined;
  let tokens = emptyUsage();
  for (const r of list) tokens = addUsage(tokens, r.usage);
  const { cost, ...rest } = tokens;
  const unpriced = list.some((r) => r.usage.cost === undefined && totalTokens(r.usage) > 0);
  return { responses: list.length, tokens: rest, ...(cost !== undefined ? { cost } : {}), ...(cost !== undefined && unpriced ? { costPartial: true } : {}) };
}

/** Tokens in the prompt for a response: what the context window held. */
export function contextTokens(u: Usage): number {
  return u.input + u.cacheRead + u.cacheWrite;
}

export function totalTokens(u: Usage): number {
  return u.input + u.cacheRead + u.cacheWrite + u.output;
}
