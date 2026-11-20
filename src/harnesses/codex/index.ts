import { statSync } from "node:fs";
import { join } from "node:path";
import type { Harness } from "../types.js";
import { allRollouts, codexSidecarKey, listRollouts, loadCodexSidecar, rolloutHeader, threadId } from "./files.js";
import { parseCodex } from "./parse.js";
import { countCodexSubagents, loadCodexSubagents } from "./subagents.js";
import { summarizeCodex } from "./summarize.js";

const codexHome = (env: NodeJS.ProcessEnv, home: string): string => env.CODEX_HOME ?? join(home, ".codex");

/** `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<time>-<thread-id>.jsonl` (and `archived_sessions/`); see files.ts. */
export const codex: Harness = {
  name: "codex",
  sessionsRoot: (env, home) => env.OVERSHARE_CODEX_SESSIONS ?? join(codexHome(env, home), "sessions"),
  listFiles: listRollouts,
  sessionId: threadId,
  sessionCwd: (file) => rolloutHeader(file)?.cwd,
  // The header line. Never `codex exec --json` output, whose lines are `thread.started`, `item.completed`, ...
  detect: (e) => {
    const p = e.payload as Record<string, unknown> | undefined;
    return e.type === "session_meta" && !!p && typeof p === "object" && typeof p.id === "string" && (typeof p.cli_version === "string" || typeof p.originator === "string");
  },
  parse: parseCodex,
  summarize: summarizeCodex,
  // Codex tells the commands it runs which thread they belong to (`codex-rs/core/src/exec_env.rs`).
  currentSession(env, root) {
    const id = env.CODEX_THREAD_ID;
    if (!id) return undefined;
    // A reverted thread has several rollouts: the newest is the one being written.
    return allRollouts(root)
      .filter((f) => threadId(f) === id)
      .map((f) => ({ f, at: statSync(f).mtimeMs }))
      .sort((a, b) => b.at - a.at)[0]?.f;
  },
  // Spawned agents write their own rollouts, filed by date like any thread; their headers name the parent.
  subagents: { load: loadCodexSubagents, count: (file) => countCodexSubagents(file) },
  sidecar: {
    load: loadCodexSidecar,
    key: codexSidecarKey,
  },
  credentialFiles: (env, home) => [join(codexHome(env, home), "auth.json")],
};
