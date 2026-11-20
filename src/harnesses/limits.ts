/** How large a transcript overshare reads into memory. */

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
