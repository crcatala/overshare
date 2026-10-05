/**
 * Where a single-file HTML export keeps its session. Shared by the exporter (`standalone.ts`) and the
 * viewer (`viewer/src/source.ts`), so the two cannot drift apart.
 */
export const EMBEDDED_SHARE_ID = "overshare-session";
