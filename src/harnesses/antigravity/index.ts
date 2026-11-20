import { existsSync } from "node:fs";
import type { Harness } from "../types.js";
import { allTranscripts, antigravitySidecarKey, conversationId, listConversations, loadAntigravitySidecar, oauthTokenFiles, projectWorkspace, workspacesOfConversation } from "./files.js";
import { STEP_SOURCES, STEP_TYPES, parseAntigravity } from "./parse.js";
import { summarizeAntigravity } from "./summarize.js";

/**
 * Google Antigravity: `<data folder>/brain/<conversation id>/.system_generated/logs/transcript_full.jsonl`, with the
 * conversation's SQLite database beside it. The root is one data folder (`$OVERSHARE_ANTIGRAVITY_DIR`, or
 * `$ANTIGRAVITY_DATA_DIR` as ccusage reads it), else the home folder, where every product's data folder is looked
 * for (desktop app, IDE, `agy`, ACP, and the ACP server T3 Code runs).
 */
export const antigravity: Harness = {
  name: "antigravity",
  sessionsRoot: (env, home) => env.OVERSHARE_ANTIGRAVITY_DIR ?? env.ANTIGRAVITY_DATA_DIR ?? home,
  listFiles: listConversations,
  sessionId: conversationId,
  sessionCwd: (file) => projectWorkspace(workspacesOfConversation(file))?.path,
  // The keys every step has, and a type and source from the known sets: generic keys alone would match other JSONL.
  detect: (e) => typeof e.step_index === "number" && typeof e.type === "string" && STEP_TYPES.has(e.type) && typeof e.source === "string" && STEP_SOURCES.test(e.source) && typeof e.status === "string" && typeof e.created_at === "string",
  parse: parseAntigravity,
  summarize: summarizeAntigravity,
  // Antigravity names the conversation for its plugin sidecars and command shims; whether `run_command` shells get it
  // too is not verified, so the newest conversation for the directory is the fallback.
  currentSession(env, root) {
    const id = env.ANTIGRAVITY_CONVERSATION_ID;
    if (!id) return undefined;
    return allTranscripts(root).find((f) => conversationId(f) === id && existsSync(f));
  },
  sidecar: { load: loadAntigravitySidecar, key: antigravitySidecarKey },
  credentialFiles: (env, home) => oauthTokenFiles(env.OVERSHARE_ANTIGRAVITY_DIR ?? env.ANTIGRAVITY_DATA_DIR ?? home),
};
