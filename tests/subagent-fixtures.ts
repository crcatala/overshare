/**
 * Committed Claude Code sessions with subagents (`tests/fixtures/claude-subagents`), laid out like
 * `~/.claude/projects`, plus the ground truth to test against: Claude Code's own `cost-state` line,
 * and usage summed straight from the raw files (independent of the adapter).
 *
 * The sessions come from a throwaway sandbox repo on Claude Code 2.1.285 and were trimmed by
 * `scripts/sanitize-claude-fixtures.mjs`: injected-context attachments dropped, usage untouched.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const SUBAGENT_FIXTURES_ROOT = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "claude-subagents");
export const SUBAGENT_FIXTURES_PROJECT = "-home-fixture-user-work-usage-sandbox";
export const SUBAGENT_FIXTURES_DIR = join(SUBAGENT_FIXTURES_ROOT, SUBAGENT_FIXTURES_PROJECT);

export type Line = Record<string, any>;

/** The four token classes `cost-state` reports per model. */
export interface TokenTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface SubagentFile {
  agentId: string;
  path: string;
  meta: Record<string, any>;
  lines: Line[];
}

export interface SubagentFixture {
  id: string;
  mainPath: string;
  main: Line[];
  subagents: SubagentFile[];
  costState: Line;
}

const readJsonl = (path: string): Line[] =>
  readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Line);

/** A missing meta file is left for the layout test to report, not thrown while collecting tests. */
function readMeta(path: string): Record<string, any> {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, any>;
  } catch {
    return {};
  }
}

export function fixtureSessionIds(): string[] {
  return readdirSync(SUBAGENT_FIXTURES_DIR).filter((f) => f.endsWith(".jsonl")).map((f) => f.slice(0, -".jsonl".length)).sort();
}

export function loadSubagentFixture(id: string): SubagentFixture {
  const mainPath = join(SUBAGENT_FIXTURES_DIR, `${id}.jsonl`);
  const main = readJsonl(mainPath);
  const dir = join(SUBAGENT_FIXTURES_DIR, id, "subagents");
  let names: string[] = [];
  try {
    names = readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort();
  } catch {
    // a session without subagents has no directory
  }
  const subagents = names.map((name) => ({
    agentId: name.slice("agent-".length, -".jsonl".length),
    path: join(dir, name),
    meta: readMeta(join(dir, name.replace(/\.jsonl$/, ".meta.json"))),
    lines: readJsonl(join(dir, name)),
  }));
  const costState = main.filter((l) => l.type === "cost-state").at(-1);
  if (!costState) throw new Error(`${id}: no cost-state line`);
  return { id, mainPath, main, subagents, costState };
}

const tokenTotal = (u: Line): number =>
  (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);

/**
 * One usage object per `message.id`: a response is split over several lines that repeat (and while
 * streaming, grow) its usage, so the largest wins. Files are merged in the order given; an id that
 * appears in two files keeps its first file's copy unless the later one is larger.
 */
export function uniqueUsage(files: Line[][]): Map<string, { model: string; usage: Line }> {
  const byId = new Map<string, { model: string; usage: Line }>();
  for (const lines of files) {
    for (const l of lines) {
      const msg = l.message;
      if (l.type !== "assistant" || !msg?.usage || !msg.id || msg.model === "<synthetic>") continue;
      const prev = byId.get(msg.id);
      if (!prev || tokenTotal(msg.usage) > tokenTotal(prev.usage)) byId.set(msg.id, { model: msg.model, usage: msg.usage });
    }
  }
  return byId;
}

/** Usage summed per model over main + every subagent file. */
export function transcriptTotals(fx: SubagentFixture): Record<string, TokenTotals> {
  const out: Record<string, TokenTotals> = {};
  for (const { model, usage } of uniqueUsage([fx.main, ...fx.subagents.map((s) => s.lines)]).values()) {
    const t = (out[model] ??= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    t.input += usage.input_tokens ?? 0;
    t.output += usage.output_tokens ?? 0;
    t.cacheRead += usage.cache_read_input_tokens ?? 0;
    t.cacheWrite += usage.cache_creation_input_tokens ?? 0;
  }
  return out;
}

/** What Claude Code's `cost-state` line reports, per model. */
export function costStateTotals(fx: SubagentFixture): Record<string, TokenTotals> {
  const out: Record<string, TokenTotals> = {};
  for (const [model, u] of Object.entries<Line>(fx.costState.modelUsage ?? {})) {
    out[model] = { input: u.inputTokens, output: u.outputTokens, cacheRead: u.cacheReadInputTokens, cacheWrite: u.cacheCreationInputTokens };
  }
  return out;
}
