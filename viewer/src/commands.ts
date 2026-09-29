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

type Token = { kind: "word"; text: string } | { kind: "op"; text: string };

/** Splits shell text into words and operators (`&&`, `||`, `|`, `;`, `&`, newline, parentheses), respecting quotes and `$(…)`. */
function tokenize(input: string): Token[] {
  const out: Token[] = [];
  let word = "";
  let inWord = false;
  const push = () => {
    if (inWord) out.push({ kind: "word", text: word });
    word = "";
    inWord = false;
  };
  const op = (text: string) => {
    push();
    out.push({ kind: "op", text });
  };
  for (let i = 0; i < input.length; i++) {
    const c = input[i]!;
    const two = input.slice(i, i + 2);
    if (c === "'" || c === '"' || c === "`") {
      // Quoted text belongs to the word; `"` honours backslashes, `'` and backticks don't.
      inWord = true;
      const start = i++;
      while (i < input.length && input[i] !== c) i += c === '"' && input[i] === "\\" ? 2 : 1;
      word += input.slice(start, i + 1);
    } else if (c === "\\") {
      inWord = true;
      word += input.slice(i, i + 2);
      i++;
    } else if (two === "$(") {
      inWord = true;
      let depth = 0;
      const start = i;
      for (; i < input.length; i++) {
        if (input[i] === "(") depth++;
        else if (input[i] === ")" && --depth === 0) break;
      }
      word += input.slice(start, i + 1);
    } else if (c === "#" && !inWord) {
      while (i < input.length && input[i] !== "\n") i++;
      i--;
    } else if (c === "\n") op(";");
    else if (/\s/.test(c)) push();
    else if (two === "&&" || two === "||" || two === ";;") {
      op(two);
      i++;
    } else if (c === "&" && (word.endsWith(">") || word.endsWith("<") || input[i + 1] === ">")) {
      // Part of a redirection (`2>&1`, `&>file`), not a background operator.
      inWord = true;
      word += c;
    } else if (c === "|" || c === ";" || c === "&" || c === "(" || c === ")") op(c);
    else {
      inWord = true;
      word += c;
    }
  }
  push();
  return out;
}

/** Programs that only start another one, with the options of theirs that take a value (and positional arguments to skip). */
const WRAPPERS: Record<string, { values?: string[]; positional?: number }> = {
  sudo: { values: ["-u", "-g", "-h", "-p", "-C", "-D", "-R", "-T", "-U"] },
  env: { values: ["-u", "-C", "-S"] },
  time: { values: ["-f", "-o"] },
  nice: { values: ["-n"] },
  nohup: {},
  exec: { values: ["-a"] },
  rtk: {},
  timeout: { values: ["-s", "-k"], positional: 1 },
  xargs: { values: ["-n", "-I", "-P", "-L", "-d", "-E", "-s", "-a"] },
};
/** Package runners: `npx vitest` is a vitest call. */
const RUNNERS = new Set(["npx", "bunx", "pnpx", "uvx"]);
/** Commands that only prepare for the next one (when something follows). */
const SETUP = new Set(["cd", "pushd", "popd", "export", "set", "unset"]);
/** Shell syntax that isn't a program: skipped, and the command after it counts. */
const SKIP = new Set(["if", "while", "until", "then", "else", "elif", "do", "done", "fi", "esac", "!", "{", "}"]);
/** Constructs whose first command isn't the interesting one: skipped up to the next separator. */
const SKIP_COMMAND = new Set(["for", "select", "case", "function", "[", "[["]);

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const REDIRECTION = /^(?:\d*|&)(?:>>?&?|<<?<?&?)(.*)$/;
const SEPARATORS = new Set([";", ";;", "&&", "||", "|", "&"]);

/** Unquote a word that is a program name: `"git"` → git. Undefined for anything else. */
function programOf(text: string): string | undefined {
  const bare = text.replace(/^(["'])(.*)\1$/, "$2");
  return /^[\w.+@~/-]+$/.test(bare) && !/^\d+$/.test(bare) ? shorten(bare) : undefined;
}

/**
 * The program a shell command runs: `git status -s` → "git", `cd app && npm test` → "npm",
 * `FOO=1 sudo -u deploy ./run.sh` → "run.sh". Assignments, redirections, wrappers (`sudo`,
 * `nice -n 10`, `timeout 5`, …) and a leading `cd` are looked through. Only the first command
 * of a pipeline counts. Undefined when no program can be named, so callers can count it apart.
 */
export function commandName(command: string): string | undefined {
  const tokens = tokenize(command);
  let i = 0;
  const endOfCommand = () => {
    while (i < tokens.length && !(tokens[i]!.kind === "op" && SEPARATORS.has(tokens[i]!.text))) i++;
  };
  const skipSeparators = () => {
    while (i < tokens.length && tokens[i]!.kind === "op") i++;
  };
  let wrapper: string | undefined;
  for (skipSeparators(); i < tokens.length; ) {
    const t = tokens[i]!;
    if (t.kind === "op") {
      // A parenthesis opens a subshell; anything else ends the command before a program was named.
      if (t.text === "(" || t.text === ")") {
        i++;
        continue;
      }
      break;
    }
    const w = t.text;
    if (ASSIGNMENT.test(w) || SKIP.has(w)) {
      i++;
      continue;
    }
    const redirect = REDIRECTION.exec(w);
    if (redirect) {
      // `> file` names its target in the next word; `2>&1` and `>file` carry it.
      i += redirect[1] ? 1 : 2;
      continue;
    }
    if (SKIP_COMMAND.has(w)) {
      endOfCommand();
      skipSeparators();
      continue;
    }
    if (SETUP.has(w)) {
      endOfCommand();
      const piped = tokens[i]?.text === "|";
      skipSeparators();
      // With nothing after it (or only a pipe), the setup command is the command.
      if (i >= tokens.length || piped) return programOf(w);
      continue;
    }
    const wrap = WRAPPERS[w];
    if (wrap) {
      wrapper ??= w;
      i++;
      let positional = wrap.positional ?? 0;
      while (i < tokens.length && tokens[i]!.kind === "word") {
        const next = (tokens[i] as { text: string }).text;
        if (next.startsWith("-")) i += wrap.values?.includes(next) ? 2 : 1;
        else if (ASSIGNMENT.test(next)) i++;
        else if (positional > 0) {
          positional--;
          i++;
        } else break;
      }
      continue;
    }
    if (RUNNERS.has(w)) {
      i++;
      while (tokens[i]?.kind === "word" && (tokens[i] as { text: string }).text.startsWith("-")) i++;
      const next = tokens[i];
      if (next?.kind === "word") return programOf(next.text);
      return programOf(w);
    }
    return programOf(w);
  }
  return wrapper;
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
 * The shell tool of a group and the commands it kept. A group records commands for its shell
 * calls as a whole, not per tool, so they can only be attributed when exactly one tool ran
 * commands and there are no more commands than calls. Everything that splits a group's shell
 * calls by program goes through this, so they all agree.
 */
export function groupShell(g: Pick<ToolGroupStep, "calls" | "commands">): { call: ToolGroupStep["calls"][number]; commands: string[] } | undefined {
  const exec = g.calls.filter((c) => isExecTool(c.name));
  return exec.length === 1 && g.commands.length <= exec[0]!.count ? { call: exec[0]!, commands: g.commands } : undefined;
}

/**
 * A tool group's calls, with shell calls split by program when the group kept the commands
 * (brief mode does, minimal does not). Counts always add up to the group's total.
 */
export function groupCalls(g: Pick<ToolGroupStep, "calls" | "commands">): CallCount[] {
  const shell = groupShell(g);
  const tally = shell ? tallyCommands(shell.commands) : [];
  const named = tally.reduce((n, [, k]) => n + k, 0);
  const out: CallCount[] = [];
  for (const c of g.calls) {
    if (c !== shell?.call || !named) {
      out.push({ label: c.name, count: c.count, errors: c.errors });
      continue;
    }
    for (const [name, count] of tally) out.push({ label: `${c.name}(${name})`, count, errors: 0 });
    if (c.count > named) out.push({ label: c.name, count: c.count - named, errors: 0 });
    if (c.errors) out.push({ label: `${c.name} errors`, count: c.errors, errors: c.errors, errorsOnly: true });
  }
  return out;
}
