import { basename, join } from "node:path";
import { jsonlSessionFiles } from "../discovery.js";
import type { Harness } from "../types.js";
import { parsePi } from "./parse.js";
import { summarizePi } from "./summarize.js";

/** pi names a working directory's folder `--<path with separators as ->--`. */
export const projectDir = (cwd: string): string => `--${cwd.replace(/^[/\\]+/, "").replace(/[/\\:]/g, "-")}--`;

/** `~/.pi/agent/sessions/--<cwd-slug>--/<timestamp>_<session-id>.jsonl`. */
export const pi: Harness = {
  name: "pi",
  sessionsRoot: (env, home) => env.AGENT_SHARE_PI_SESSIONS ?? env.PI_CODING_AGENT_SESSION_DIR ?? join(env.PI_CODING_AGENT_DIR ?? join(home, ".pi", "agent"), "sessions"),
  listFiles: (root, cwd) => jsonlSessionFiles(root, cwd === undefined ? undefined : projectDir(cwd)),
  sessionId: (file) => {
    const name = basename(file, ".jsonl");
    return name.split("_").at(-1) ?? name;
  },
  detect: (e) => e.type === "session" && typeof e.version === "number",
  parse: parsePi,
  summarize: summarizePi,
  credentialFiles: (env, home) => [join(env.PI_CODING_AGENT_DIR ?? join(home, ".pi", "agent"), "auth.json")],
};
