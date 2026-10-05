import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Write `text` to `path` so that only the current user can read it, and so that a reader never sees half a file.
 *
 * The index holds prompt text copied out of Claude Code's private (0700) project directories, and `shares.json`
 * holds unlisted share links, which work as capabilities. Neither should be readable by other users of the machine.
 * `mkdir`/`writeFile` modes only apply to what they create, but the file is replaced by rename, so one that exists
 * with looser permissions is fixed the next time it is saved. Throws on failure; the caller decides whether that matters.
 */
export function writePrivateFile(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, path);
}
