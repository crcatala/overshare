import { randomBytes } from "node:crypto";
import { closeSync, mkdirSync, openSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Write `text` to `path` as a file only the current user can read, and so that a reader never sees half a file.
 *
 * The index holds prompt text copied out of Claude Code's private (0700) project directories, `shares.json` holds
 * unlisted share links, which work as capabilities, and `browse.json` is kept the same way so there is one writer.
 * None should be readable by other users of the machine.
 *
 * `mkdir`/`writeFile` modes only apply to what they create. A missing directory is created 0700, but one that already
 * exists keeps its mode. The file is always new: the temp file has a random name and is created exclusively (`wx`), so
 * a leftover or planted file at that name makes the write fail rather than lend it its mode, and the rename replaces
 * the target, so one that exists with looser permissions is fixed the next time it is saved. Throws on failure; the
 * caller decides whether that matters.
 */
export function writePrivateFile(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  const fd = openSync(tmp, "wx", 0o600);
  try {
    try {
      writeFileSync(fd, text);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}
