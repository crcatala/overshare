/**
 * Turns a fetched share into the session the viewer renders, whichever format version wrote it.
 *
 * The viewer only understands the current format (`SCHEMA_VERSION`). A share from another version is
 * handled by its position relative to that:
 *   - same version: used as is.
 *   - newer (made by a newer overshare): rendered best effort, with a notice. Additive changes (new
 *     optional fields, new step kinds) mostly work; the renderer shows what it can't read as a placeholder.
 *   - older: upgraded step by step through MIGRATIONS, each one a pure function from one version's JSON to
 *     the next's. A version with no path to the current one is refused with a message saying so.
 * A format named under the project's earlier name (`agentshare/2`) is read as the overshare version it is
 * (`LEGACY_SCHEMA_VERSIONS`).
 *
 * Migrations load on demand (a dynamic import, so its own chunk): a current share never fetches one.
 */
import { LEGACY_SCHEMA_VERSIONS, SCHEMA_VERSION, type NormalizedSession } from "../../src/schema.ts";

/** A migration takes a share of version N (it may mutate it; it was just parsed) and returns it as version N+1. */
export type Migration = (share: Record<string, unknown>) => Record<string, unknown>;
export type Migrations = Record<number, () => Promise<{ default: Migration }>>;

/**
 * Migrations by the version they upgrade *from*. Empty: overshare/1 (the same format as agentshare/2, its
 * name before the rename) is the oldest format this viewer opens. When the format changes incompatibly:
 *   1. bump SCHEMA_VERSION,
 *   2. add `1: () => import("./migrations/v1-to-v2.ts")` here, exporting `default` that returns the v2 shape,
 *   3. freeze a v2 share in tests/fixtures/shares/ (the tests fail until you do).
 */
export const MIGRATIONS: Migrations = {};

const SCHEMA = /^overshare\/(\d+)$/;

/** `overshare/1` → 1, and a pre-rename format as the version it is (`agentshare/2` → 1); undefined for anything else. */
export function schemaVersion(schema: unknown): number | undefined {
  if (typeof schema === "string" && Object.hasOwn(LEGACY_SCHEMA_VERSIONS, schema)) return LEGACY_SCHEMA_VERSIONS[schema];
  const m = typeof schema === "string" ? SCHEMA.exec(schema) : null;
  return m ? Number(m[1]) : undefined;
}

export interface ReadShare {
  session: NormalizedSession;
  /** Set when the share is newer than this viewer: the two formats, for a notice above the transcript. */
  newer?: { shared: string; viewer: string };
}

export async function readShare(data: unknown, migrations: Migrations = MIGRATIONS): Promise<ReadShare> {
  const current = schemaVersion(SCHEMA_VERSION)!;
  let doc = data as Record<string, unknown> | null;
  const version = schemaVersion(doc?.schema);
  if (!doc || typeof doc !== "object" || version === undefined) {
    const found = typeof doc?.schema === "string" ? doc.schema : "none";
    throw new Error(`This isn't an overshare session (format: ${found}).`);
  }
  const newer = version > current ? { shared: String(doc.schema), viewer: SCHEMA_VERSION } : undefined;
  for (let v = version; v < current; v++) {
    const load = migrations[v];
    if (!load) throw new Error(`This session was shared in an older format (${doc.schema}) that this viewer can no longer open.`);
    doc = { ...(await load()).default(doc), schema: `overshare/${v + 1}` };
  }
  // A pre-rename name for the current version reads as the current one.
  if (!newer) doc = { ...doc, schema: SCHEMA_VERSION };
  if (!Array.isArray(doc.turns)) throw new Error("This session has no turns to show.");
  return { session: { ...doc, turns: tidyTurns(doc.turns) } as unknown as NormalizedSession, ...(newer ? { newer } : {}) };
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * The shape every pass after this one iterates without checking: turns that are objects, each with a list
 * of steps that are objects. What a step holds is checked where it is read (an unreadable one becomes a
 * placeholder); this only keeps one malformed turn or step from failing the token rail, a view or the
 * search for the whole session.
 */
function tidyTurns(turns: unknown[]): Record<string, unknown>[] {
  return turns.filter(isObject).map((turn) => ({ ...turn, steps: Array.isArray(turn.steps) ? turn.steps.filter(isObject) : [] }));
}
