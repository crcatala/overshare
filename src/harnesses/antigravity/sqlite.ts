/**
 * Read-only access to Antigravity's SQLite files through Node's built-in `node:sqlite` (no dependency).
 *
 * - Loaded lazily, only when a conversation database is actually read, so no other command pays for it.
 * - Node 22.x prints `ExperimentalWarning: SQLite is an experimental feature` when it is first loaded (24.x does not).
 *   That one warning is kept off the user's terminal; every other warning still goes through.
 * - Opened read-only: `mode=ro`, plus `immutable=1` when no `-wal` file has content (then SQLite does not touch the
 *   `-shm` file either). The running agent may hold the file open in WAL mode; reading never writes to its folder.
 */
import { createRequire } from "node:module";
import { statSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** The part of `node:sqlite` used here. */
interface Statement {
  all(...params: unknown[]): Record<string, unknown>[];
  get(...params: unknown[]): Record<string, unknown> | undefined;
}
export interface Database {
  prepare(sql: string): Statement;
  close(): void;
}
type SqliteModule = { DatabaseSync: new (path: string | URL, options?: Record<string, unknown>) => Database };

let loaded: SqliteModule | null | undefined;

function sqlite(): SqliteModule | null {
  if (loaded !== undefined) return loaded;
  const original = process.emitWarning;
  // Only this warning, while `node:sqlite` loads: Node emits it from the module's first `require`.
  process.emitWarning = function (this: unknown, warning: string | Error, ...rest: unknown[]) {
    const message = typeof warning === "string" ? warning : warning?.message;
    const type = typeof rest[0] === "string" ? rest[0] : (rest[0] as { type?: string } | undefined)?.type;
    if (type === "ExperimentalWarning" && /SQLite/i.test(String(message))) return;
    return (original as (...a: unknown[]) => void).call(process, warning, ...rest);
  } as typeof process.emitWarning;
  try {
    loaded = createRequire(import.meta.url)("node:sqlite") as SqliteModule;
  } catch {
    // A Node without node:sqlite: the conversation databases are simply not read.
    loaded = null;
  } finally {
    process.emitWarning = original;
  }
  return loaded;
}

const walHasContent = (path: string): boolean => {
  try {
    return statSync(`${path}-wal`).size > 0;
  } catch {
    return false;
  }
};

/** Run `read` on the database at `path`, opened read-only; undefined if it cannot be opened or read. */
export function withDatabase<T>(path: string, read: (db: Database) => T): T | undefined {
  const mod = sqlite();
  if (!mod) return undefined;
  let db: Database | undefined;
  try {
    const url = pathToFileURL(path);
    url.searchParams.set("mode", "ro");
    if (!walHasContent(path)) url.searchParams.set("immutable", "1");
    db = new mod.DatabaseSync(url);
    return read(db);
  } catch {
    return undefined;
  } finally {
    try {
      db?.close();
    } catch {
      // already closed
    }
  }
}
