/**
 * Shell commands, named by the program they run, so "Bash ×12" can read as
 * "Bash(git) ×5 · Bash(npm) ×4 · Bash(ls) ×3". Used by the outline, the tool-group
 * chips and the token rail's tool list.
 */
import type { ToolGroupStep } from "../../src/schema.ts";

const MAX_NAME = 24;

/** Tool names whose calls run a shell command (mirrors the adapters' "exec" action). */
export function isExecTool(name: string): boolean {
  return /^(bash|shell|exec_command)$/i.test(name);
}

/** Programs that only start another one: the interesting name is what they run. */
const WRAPPERS = new Set(["sudo", "env", "time", "nice", "nohup", "command", "exec", "builtin", "rtk"]);
/** Package runners: `npx vitest` is a vitest call. */
const RUNNERS = new Set(["npx", "bunx", "pnpx", "uvx"]);

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * The program a shell command runs: `git status -s` → "git", `cd app && npm test` → "npm",
 * `FOO=1 sudo ./deploy.sh` → "deploy.sh". Only the first command of a pipeline or list
 * counts. Returns undefined when nothing recognisable is there.
 */
export function commandName(command: string): string | undefined {
  // Leading `cd <dir> &&` / `cd <dir>;` only sets the scene for the real command.
  const words = command.replace(/^[\s(]*(cd\s+\S+\s*(&&|;)\s*)+/, "").trim().split(/\s+/);
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!.replace(/^[("'`!{]+/, "").replace(/["'`]+$/, "");
    if (!w || ASSIGNMENT.test(w) || WRAPPERS.has(w) || w.startsWith("-")) continue;
    if (RUNNERS.has(w)) {
      const next = words.slice(i + 1).find((x) => !x.startsWith("-"));
      if (next) return shorten(next);
    }
    return shorten(w);
  }
  return undefined;
}

function shorten(word: string): string | undefined {
  const name = word.replace(/[;|&)]+$/, "").split("/").filter(Boolean).at(-1) ?? "";
  if (!name) return undefined;
  return name.length > MAX_NAME ? `${name.slice(0, MAX_NAME - 1)}…` : name;
}

/** Commands counted by program, most used first (ties alphabetical). Unnameable ones are left out. */
export function tallyCommands(commands: Iterable<string>): [name: string, count: number][] {
  const counts = new Map<string, number>();
  for (const c of commands) {
    const name = commandName(c);
    if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

export interface CallCount {
  /** What to show: "Edit", or "Bash(git)" for a shell call. */
  label: string;
  count: number;
  errors: number;
  /** Errors of a shell tool that were split by program: they can't be assigned to one of the parts. */
  errorsOnly?: boolean;
}

/**
 * A tool group's calls, with shell calls split by program when the group kept the commands
 * (brief mode does, minimal does not). Counts always add up to the group's total.
 */
export function groupCalls(g: Pick<ToolGroupStep, "calls" | "commands">): CallCount[] {
  const exec = g.calls.filter((c) => isExecTool(c.name));
  // Commands are recorded for the exec calls as a whole, so they only split a single exec tool.
  const shell = exec.length === 1 && g.commands.length <= exec[0]!.count ? exec[0]! : undefined;
  const tally = shell ? tallyCommands(g.commands) : [];
  const named = tally.reduce((n, [, k]) => n + k, 0);
  const out: CallCount[] = [];
  for (const c of g.calls) {
    if (c !== shell || !named) {
      out.push({ label: c.name, count: c.count, errors: c.errors });
      continue;
    }
    for (const [name, count] of tally) out.push({ label: `${c.name}(${name})`, count, errors: 0 });
    if (c.count > named) out.push({ label: c.name, count: c.count - named, errors: 0 });
    if (c.errors) out.push({ label: `${c.name} errors`, count: c.errors, errors: c.errors, errorsOnly: true });
  }
  return out;
}
