import { closeSync, openSync, readSync, readdirSync, type Dirent } from "node:fs";
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

/**
 * The first line of a file (without its newline), read a block at a time up to `maxBytes`; undefined when the file
 * cannot be read or its first line is longer than that. For harnesses that keep a session's working directory in a
 * header line rather than in its folder's name.
 */
export function readFirstLine(path: string, maxBytes = 1 << 20): string | undefined {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return undefined;
  }
  try {
    const chunks: Buffer[] = [];
    let total = 0;
    const buf = Buffer.alloc(64 * 1024);
    for (let n = readSync(fd, buf, 0, buf.length, null); n > 0; n = readSync(fd, buf, 0, buf.length, null)) {
      const end = buf.subarray(0, n).indexOf(10);
      if (end >= 0) {
        chunks.push(Buffer.from(buf.subarray(0, end)));
        return Buffer.concat(chunks).toString("utf8");
      }
      chunks.push(Buffer.from(buf.subarray(0, n)));
      total += n;
      if (total > maxBytes) return undefined;
    }
    return total > 0 ? Buffer.concat(chunks).toString("utf8") : undefined;
  } catch {
    return undefined;
  } finally {
    closeSync(fd);
  }
}

/** Every file under `dir` (recursively, at most `depth` folders down) whose name passes `keep`. */
export function walkFiles(dir: string, keep: (name: string) => boolean, depth = 4): string[] {
  const out: string[] = [];
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const path = join(dir, e.name);
    if (e.isDirectory()) {
      if (depth > 0) out.push(...walkFiles(path, keep, depth - 1));
    } else if (e.isFile() && keep(e.name)) out.push(path);
  }
  return out;
}
