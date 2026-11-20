import { join } from "node:path";
import type { Harness } from "../types.js";
import { allRollouts, listRollouts, loadCodexSidecar, rolloutHeader, threadId } from "./files.js";
import { parseCodex } from "./parse.js";
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
    return allRollouts(root).find((f) => threadId(f) === id);
  },
  sidecar: {
    load: loadCodexSidecar,
    key: (file) => loadCodexSidecar(file).title ?? "",
  },
  credentialFiles: (env, home) => [join(codexHome(env, home), "auth.json")],
};
