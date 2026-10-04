import type { AgentShareConfig } from "../config.js";
import { HARNESS_META, HARNESS_NAMES, type HarnessName } from "../harnesses/meta.js";
import { defaultRoots } from "../resolve.js";
import { IndexJob } from "../sessions/index.js";
import { BrowserApp } from "./app.js";
import { runScreen } from "./kit.js";
import { fileSettings } from "./settings.js";
import { createSource } from "./source.js";

export interface BrowseOptions {
  config: AgentShareConfig;
  /** Start with this harness filter (the list still indexes both). */
  harness?: HarnessName;
  /** Start with this search text. */
  query?: string;
}

/** Open the interactive session browser. Needs a TTY on both ends. */
export function runBrowse(opts: BrowseOptions): void {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("browse needs an interactive terminal; use `agent-share list` in scripts");
  }
  // The list paints from a stat-only listing at once; summaries are read in the background and fill in
  // (the first run reads every transcript, seconds for hundreds of sessions; later runs read only what changed).
  const job = new IndexJob();
  if (job.sessions.length === 0) {
    job.stop();
    const roots = defaultRoots();
    throw new Error(`no sessions found (looked in ${HARNESS_NAMES.map((n) => `${HARNESS_META[n].label}: ${roots[n]}`).join("; ")})`);
  }
  // Whatever ends the process (quit, ctrl-c, a crash), keep what has been read.
  process.on("exit", () => job.stop());
  runScreen(new BrowserApp(createSource({ config: opts.config, sessions: job.sessions, index: job }), { query: opts.query, harness: opts.harness, settings: fileSettings() }));
}
