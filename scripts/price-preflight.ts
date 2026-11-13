/**
 * Price checks for `npm run audit:usage` (node built-ins only, so it can run before the audit loads the price table).
 *
 * - Freshness: runs the generator in check mode (`scripts/update-prices.ts --check --json -`, no cross-check). A
 *   stale table is a warning naming what changed and the fix; offline or any generator failure is a warning too,
 *   and the audit runs on the committed table.
 * - `--refresh`: regenerates the table first (only touches the repo).
 * - Unpriced models seen in local sessions: see `unpricedProblem`.
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const GENERATOR = join(import.meta.dirname, "update-prices.ts");

export interface Preflight {
  /** Lines to print before the audit (warnings start with "WARNING"). */
  lines: string[];
  /** The table was regenerated (`--refresh`). */
  refreshed?: boolean;
}

interface Summary {
  snapshot: string;
  upToDate: boolean;
  added: string[];
  removed: string[];
  changed: { id: string; fields: Record<string, [unknown, unknown]> }[];
}

const run = (args: string[], env: NodeJS.ProcessEnv) =>
  spawnSync(process.execPath, ["--import", "tsx", GENERATOR, "--no-cross-check", ...args], { encoding: "utf8", timeout: 60_000, env, cwd: join(import.meta.dirname, "..") });

const firstError = (stderr: string | undefined) => (stderr ?? "").split("\n").find((l) => l.startsWith("update-prices failed")) ?? (stderr ?? "").trim().split("\n").at(-1) ?? "";

/**
 * Check the committed price table against models.dev (or regenerate it with `refresh`). Never throws. `generatorArgs`
 * go to the generator as well (tests: `--from`, `--table`).
 */
export function pricePreflight(opts: { refresh?: boolean; env?: NodeJS.ProcessEnv; generatorArgs?: string[] } = {}): Preflight {
  const env = opts.env ?? process.env;
  const extra = opts.generatorArgs ?? [];
  if (opts.refresh) {
    const r = run(extra, env);
    if (r.status === 0) return { lines: [`Price table regenerated from models.dev (${r.stderr.includes("up to date") ? "no change" : "updated src/pricing-data.ts"}).`], refreshed: true };
    return { lines: [`WARNING: could not refresh the price table (${firstError(r.stderr) || r.error?.message || `exit ${r.status}`}); auditing with the committed one.`] };
  }
  const r = run([...extra, "--check", "--json", "-"], env);
  let s: Summary | undefined;
  try {
    if (r.status === 0 || r.status === 1) s = JSON.parse(r.stdout) as Summary;
  } catch {
    s = undefined;
  }
  if (!s) return { lines: [`WARNING: could not check the price table against models.dev (${firstError(r.stderr) || r.error?.message || `exit ${r.status}`}); auditing with the committed one.`] };
  if (r.status === 0) return { lines: [`Price table is current with models.dev (snapshot ${s.snapshot}).`] };
  const parts = [
    ...s.added.map((id) => `${id} added`),
    ...s.changed.map((c) => `${c.id} ${Object.entries(c.fields).map(([k, [a, b]]) => (k === "tiers" ? "tiers changed" : `${k} ${a} -> ${b}`)).join(", ")}`),
    ...s.removed.map((id) => `${id} removed`),
  ];
  return {
    lines: [
      `WARNING: the committed price table is stale (models.dev snapshot ${s.snapshot}): ${parts.length ? parts.join("; ") : "header or format only"}.`,
      "  The audit below uses the committed table. Fix: npm run update:prices (or rerun with --refresh).",
    ],
  };
}

/**
 * Models seen in local sessions with no price, as a failure (or a warning with `allow`). Undefined when every model
 * is priced.
 */
export function unpricedProblem(unpriced: Map<string, number>, allow: boolean): { fail: boolean; lines: string[] } | undefined {
  if (unpriced.size === 0) return undefined;
  const list = [...unpriced].sort((a, b) => b[1] - a[1]);
  const head = allow ? "WARNING: models with no price (allowed by --allow-unpriced):" : "FAIL: models with no price in local sessions:";
  return {
    fail: !allow,
    lines: [
      head,
      ...list.map(([m, n]) => `  ${m} (${n} call${n === 1 ? "" : "s"})`),
      "  Fix: npm run update:prices, or add the model to SUPPLEMENTAL_PRICES in src/pricing.ts if models.dev does not list it.",
      ...(allow ? [] : ["  Rerun with --allow-unpriced to audit anyway."]),
    ],
  };
}
