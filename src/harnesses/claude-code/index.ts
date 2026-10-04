import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { jsonlSessionFiles } from "../discovery.js";
import type { Harness } from "../types.js";
import { parseClaudeCode } from "./parse.js";
import { countSubagentFiles, loadSubagentFiles } from "./subagent-files.js";
import { summarizeClaude } from "./summarize.js";

/** Claude Code names a working directory's folder by replacing everything but letters and digits with `-`. */
export const projectDir = (cwd: string): string => cwd.replace(/[^A-Za-z0-9]/g, "-");

const sessionId = (file: string): string => basename(file, ".jsonl");

/** `~/.claude/projects/<cwd-slug>/<session-id>.jsonl`, with `<session-id>/subagents/agent-*.jsonl` beside it. */
export const claudeCode: Harness = {
  name: "claude-code",
  sessionsRoot: (env, home) => env.AGENT_SHARE_CLAUDE_PROJECTS ?? join(env.CLAUDE_CONFIG_DIR ?? join(home, ".claude"), "projects"),
  listFiles: (root, cwd) => jsonlSessionFiles(root, cwd === undefined ? undefined : projectDir(cwd)),
  sessionId,
  detect: (e) => typeof e.sessionId === "string" || typeof e.uuid === "string" || e.type === "summary",
  parse: parseClaudeCode,
  summarize: summarizeClaude,
  // Claude Code tells the processes it starts which session they run in.
  currentSession(env, root, cwd) {
    const id = env.CLAUDE_CODE_SESSION_ID;
    if (!id) return undefined;
    const preferred = join(root, projectDir(cwd), `${id}.jsonl`);
    if (existsSync(preferred)) return preferred;
    return jsonlSessionFiles(root).find((f) => sessionId(f) === id);
  },
  subagents: { load: loadSubagentFiles, count: countSubagentFiles },
  credentialFiles: (env, home) => [join(env.CLAUDE_CONFIG_DIR ?? join(home, ".claude"), ".credentials.json")],
};
