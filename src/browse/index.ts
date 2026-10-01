import type { AgentShareConfig } from "../config.js";
import type { HarnessName } from "../schema.js";
import { buildIndex } from "../sessions/index.js";
import { BrowserApp } from "./app.js";
import { runScreen } from "./kit.js";
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
  // The first run reads every transcript (seconds for hundreds of sessions); later runs only stat. Say so.
  const progress = process.stderr.isTTY;
  const sessions = buildIndex({
    onProgress: (p) => {
      if (progress && p.parsed > 0) process.stderr.write(`\rindexing sessions… ${p.done}/${p.total}`);
    },
  });
  if (progress) process.stderr.write("\x1b[2K\r");
  if (sessions.length === 0) {
    throw new Error("no sessions found (looked in the Claude Code and pi session directories; see AGENT_SHARE_CLAUDE_PROJECTS / AGENT_SHARE_PI_SESSIONS)");
  }
  runScreen(new BrowserApp(createSource({ config: opts.config, sessions }), { query: opts.query, harness: opts.harness }));
}
