import { existsSync, readdirSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { HarnessName } from "./schema.js";

export interface SessionRoots {
  "claude-code": string;
  pi: string;
}

export interface SessionRef {
  path: string;
  harness: HarnessName;
  id: string;
  mtimeMs: number;
  size: number;
}

export function defaultRoots(env: NodeJS.ProcessEnv = process.env): SessionRoots {
  const home = homedir();
  return {
    "claude-code": env.AGENT_SHARE_CLAUDE_PROJECTS ?? join(env.CLAUDE_CONFIG_DIR ?? join(home, ".claude"), "projects"),
    pi: env.AGENT_SHARE_PI_SESSIONS ?? env.PI_CODING_AGENT_SESSION_DIR ?? join(env.PI_CODING_AGENT_DIR ?? join(home, ".pi", "agent"), "sessions"),
  };
}

/** Directory name each harness uses for a working directory. */
export function projectDirName(harness: HarnessName, cwd: string): string {
  if (harness === "claude-code") return cwd.replace(/[^A-Za-z0-9]/g, "-");
  return `--${cwd.replace(/^[/\\]+/, "").replace(/[/\\:]/g, "-")}--`;
}

function sessionIdFromFile(harness: HarnessName, file: string): string {
  const name = basename(file, ".jsonl");
  return harness === "pi" ? (name.split("_").at(-1) ?? name) : name;
}

function listDir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function refFor(harness: HarnessName, path: string): SessionRef {
  const st = statSync(path);
  return { path, harness, id: sessionIdFromFile(harness, path), mtimeMs: st.mtimeMs, size: st.size };
}

/** All top-level session files for a harness (subagent/sidechain files are excluded). */
export function listSessions(harness: HarnessName, roots: SessionRoots, projectDir?: string): SessionRef[] {
  const root = roots[harness];
  const dirs = projectDir ? [projectDir] : listDir(root).filter((d) => !d.startsWith(".session"));
  const refs: SessionRef[] = [];
  for (const dir of dirs) {
    for (const f of listDir(join(root, dir))) {
      if (!f.endsWith(".jsonl") || f.startsWith("agent-")) continue;
      try {
        refs.push(refFor(harness, join(root, dir, f)));
      } catch {
        // vanished between readdir and stat
      }
    }
  }
  return refs.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

export interface ResolveOptions {
  current?: boolean;
  harness?: HarnessName;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  roots?: SessionRoots;
}

/**
 * Resolve a session from a path, a session id / id prefix, or `--current`
 * (Claude Code: `$CLAUDE_CODE_SESSION_ID`; otherwise the newest session for the cwd).
 */
export function resolveSession(arg: string | undefined, opts: ResolveOptions = {}): SessionRef {
  const env = opts.env ?? process.env;
  const roots = opts.roots ?? defaultRoots(env);
  const cwd = opts.cwd ?? process.cwd();
  const harnesses: HarnessName[] = opts.harness ? [opts.harness] : ["claude-code", "pi"];

  if (arg && existsSync(arg) && statSync(arg).isFile()) {
    return refFor(opts.harness ?? sniffHarness(arg), resolve(arg));
  }
  if (arg) {
    const matches = harnesses.flatMap((h) =>
      listSessions(h, roots).filter((r) => r.id.startsWith(arg) || basename(r.path).startsWith(arg)),
    );
    const unique = [...new Map(matches.map((m) => [m.path, m])).values()];
    if (unique.length === 1) return unique[0]!;
    if (unique.length === 0) throw new Error(`No session matches "${arg}"`);
    throw new Error(`"${arg}" is ambiguous:\n${unique.slice(0, 10).map((m) => `  ${m.harness}  ${m.id}  ${m.path}`).join("\n")}`);
  }
  if (!opts.current) throw new Error("Pass a session path or id, or use --current");

  const claudeId = env.CLAUDE_CODE_SESSION_ID;
  if (claudeId && harnesses.includes("claude-code")) {
    const preferred = join(roots["claude-code"], projectDirName("claude-code", cwd), `${claudeId}.jsonl`);
    if (existsSync(preferred)) return refFor("claude-code", preferred);
    const found = listSessions("claude-code", roots).find((r) => r.id === claudeId);
    if (found) return found;
  }
  const candidates = harnesses
    .flatMap((h) => listSessions(h, roots, projectDirName(h, cwd)))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  if (candidates[0]) return candidates[0];
  throw new Error(`No ${opts.harness ?? ""} session found for ${cwd}`.replace("  ", " "));
}

/** Cheap harness detection from the first bytes of a file. */
export function sniffHarness(path: string): HarnessName {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(4096);
    const n = readSync(fd, buf, 0, buf.length, 0);
    const first = buf.subarray(0, n).toString("utf8").split("\n", 1)[0] ?? "";
    return /"type"\s*:\s*"session"/.test(first) && /"version"\s*:\s*\d/.test(first) ? "pi" : "claude-code";
  } finally {
    closeSync(fd);
  }
}
