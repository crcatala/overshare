import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SubagentFileInput } from "../shared.js";

/**
 * The subagent transcripts of a Claude Code session file: `<session>/subagents/agent-*.jsonl`, with an
 * `agent-*.meta.json` beside each. Claude Code's layout has changed between versions, so nothing is
 * required: a missing directory, an unreadable file or a malformed meta file just yields less.
 */
export function loadSubagentFiles(sessionPath: string): SubagentFileInput[] {
  const dir = join(sessionPath.replace(/\.jsonl$/, ""), "subagents");
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const files: SubagentFileInput[] = [];
  for (const name of names.filter((n) => n.startsWith("agent-") && n.endsWith(".jsonl")).sort()) {
    try {
      const raw = readFileSync(join(dir, name), "utf8");
      files.push({ fileName: name, raw, meta: readMeta(join(dir, name.replace(/\.jsonl$/, ".meta.json"))) });
    } catch {
      // vanished or unreadable
    }
  }
  return files;
}

function readMeta(path: string): Record<string, unknown> | undefined {
  try {
    const meta: unknown = JSON.parse(readFileSync(path, "utf8"));
    return meta && typeof meta === "object" && !Array.isArray(meta) ? (meta as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** How many subagent transcripts sit next to a session file (a cheap count for the browser's index; nothing is read). */
export function countSubagentFiles(path: string, id: string): number {
  const dir = join(dirname(path), id, "subagents");
  if (!existsSync(dir)) return 0;
  try {
    return readdirSync(dir).filter((f) => f.endsWith(".jsonl")).length;
  } catch {
    return 0;
  }
}
