import type { OvershareConfig } from "../config.js";
import type { HarnessName } from "../schema.js";
import { IndexJob } from "../sessions/index.js";
import { BrowserApp } from "./app.js";
import { runScreen } from "./kit.js";
import { fileSettings } from "./settings.js";
import { createSource } from "./source.js";

export interface BrowseOptions {
  config: OvershareConfig;
  /** Start with this harness filter (the list still indexes both). */
  harness?: HarnessName;
  /** Start with this search text. */
  query?: string;
}

/** Open the interactive session browser. Needs a TTY on both ends. */
export function runBrowse(opts: BrowseOptions): void {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("browse needs an interactive terminal; use `overshare list` in scripts");
  }
  // The list paints from a stat-only listing at once; summaries are read in the background and fill in
  // (the first run reads every transcript, seconds for hundreds of sessions; later runs read only what changed).
  const job = new IndexJob();
  if (job.sessions.length === 0) {
    job.stop();
    throw new Error("no sessions found (looked in the Claude Code and pi session directories; see OVERSHARE_CLAUDE_PROJECTS / OVERSHARE_PI_SESSIONS)");
  }
  // Whatever ends the process (quit, ctrl-c, a crash), keep what has been read.
  process.on("exit", () => job.stop());
  runScreen(new BrowserApp(createSource({ config: opts.config, sessions: job.sessions, index: job }), { query: opts.query, harness: opts.harness, settings: fileSettings() }));
}
