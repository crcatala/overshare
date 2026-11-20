/** How large a transcript overshare reads into memory, and reading one (plain, or zstd-compressed). */
import { readFileSync, statSync } from "node:fs";
import { zstdDecompressSync } from "node:zlib";

/** Default for `maxSessionBytes`: well under the longest string Node can hold, which a whole-file read needs. */
const DEFAULT_MAX_SESSION_MB = 256;

/** The largest transcript overshare reads into memory: `OVERSHARE_MAX_SESSION_MB` megabytes, else 256. */
export function maxSessionBytes(env: NodeJS.ProcessEnv = process.env): number {
  const mb = Number(env.OVERSHARE_MAX_SESSION_MB);
  return (Number.isFinite(mb) && mb > 0 ? mb : DEFAULT_MAX_SESSION_MB) * 1024 * 1024;
}

const megabytes = (bytes: number): string => `${Math.ceil(bytes / (1024 * 1024)).toLocaleString("en-US")} MB`;

/** A transcript larger than `maxSessionBytes`. The message is fixed text and sizes: it never quotes the file or its path. */
export class SessionTooLargeError extends Error {
  constructor(
    readonly size: number,
    readonly limit: number,
  ) {
    super(`The session file is ${megabytes(size)}, more than the ${megabytes(limit)} overshare reads (set OVERSHARE_MAX_SESSION_MB to raise it)`);
    this.name = "SessionTooLargeError";
  }
}

/** Throws `SessionTooLargeError` when a file of `size` bytes is over the limit. */
export function checkSessionSize(size: number, env: NodeJS.ProcessEnv = process.env): void {
  const limit = maxSessionBytes(env);
  if (size > limit) throw new SessionTooLargeError(size, limit);
}

/** A transcript file kept zstd-compressed (Codex recompresses idle rollouts to `rollout-*.jsonl.zst`). */
export const isCompressed = (path: string): boolean => path.endsWith(".zst");

/**
 * The text of a transcript file, decompressing a `.zst` one (Node's zlib has zstd since 22.15, without an
 * ExperimentalWarning), within `maxSessionBytes`: a plain file is checked by its size before it is read, a compressed
 * one while it is decompressed (it may grow far past its size on disk).
 */
export function readTranscript(path: string, env: NodeJS.ProcessEnv = process.env): string {
  const limit = maxSessionBytes(env);
  if (!isCompressed(path)) {
    checkSessionSize(statSync(path).size, env);
    return readFileSync(path, "utf8");
  }
  try {
    return zstdDecompressSync(readFileSync(path), { maxOutputLength: limit }).toString("utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE") throw new SessionTooLargeError(limit + 1, limit);
    throw err;
  }
}
