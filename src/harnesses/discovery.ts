import { readdirSync } from "node:fs";
import { join } from "node:path";

export function listDir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * The layout both Claude Code and pi use: `<root>/<one directory per working directory>/<session>.jsonl`. A subagent's
 * own file (`agent-*`) is not a session. With `projectDir`, only that directory is read.
 */
export function jsonlSessionFiles(root: string, projectDir?: string): string[] {
  const dirs = projectDir ? [projectDir] : listDir(root).filter((d) => !d.startsWith(".session"));
  return dirs.flatMap((dir) => listDir(join(root, dir)).filter((f) => f.endsWith(".jsonl") && !f.startsWith("agent-")).map((f) => join(root, dir, f)));
}
