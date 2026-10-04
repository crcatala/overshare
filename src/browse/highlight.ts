/**
 * A small syntax highlighter for the viewer's code blocks: shell, JSON, diffs and the C-like / script languages
 * agents mostly write. It colours tokens line by line (a `/* … *\/` comment is the only state kept across lines) and never
 * fails: an unknown language comes back unchanged. Not a parser, and not trying to be one; a missed token is just plain text.
 */
import { st } from "./kit.js";

const c = (code: number) => (s: string): string => `\x1b[38;5;${code}m${s}\x1b[39m`;
const color = {
  keyword: c(176),
  string: c(114),
  number: c(215),
  comment: c(244),
  command: c(75),
  flag: c(180),
  variable: c(81),
  key: c(110),
  punct: c(246),
  type: c(180),
};

const LANGUAGE: Record<string, string> = {
  sh: "shell", bash: "shell", zsh: "shell", shell: "shell", console: "shell", fish: "shell",
  json: "json", jsonc: "json", json5: "json",
  diff: "diff", patch: "diff",
  js: "script", jsx: "script", mjs: "script", cjs: "script", ts: "script", tsx: "script", typescript: "script", javascript: "script",
  py: "script", python: "script", go: "script", rs: "script", rust: "script", java: "script", c: "script", h: "script", cpp: "script", cc: "script", cs: "script",
  swift: "script", kt: "script", rb: "script", ruby: "script", php: "script", lua: "script", css: "script", scss: "script", sql: "script", yaml: "script", yml: "script", toml: "script",
};

/** The highlighting family for a fence language or a file extension; undefined when there is none. */
export function languageOf(lang: string | undefined): string | undefined {
  return lang ? LANGUAGE[lang.toLowerCase().replace(/^\./, "")] : undefined;
}

/** The family for a file path, from its extension. */
export const languageOfPath = (path: string | undefined): string | undefined => languageOf(/\.([A-Za-z0-9]+)$/.exec(path ?? "")?.[1]);

const KEYWORDS = new Set(
  (
    "abstract as async await break case catch class const continue declare def default defer delete do elif else enum except export extends extern false " +
    "final finally fn for from func function go if impl implements import in instanceof interface is lambda let match mod module mut namespace new nil none None " +
    "not null of or package pass private protected pub public raise readonly return select self static struct super switch then this throw trait true True " +
    "try type typeof union unsafe use using var void where while with yield select insert update create table into values and order group by limit"
  ).split(" "),
);

const SHELL_KEYWORDS = new Set("if then else elif fi for while until do done case esac in function select time export local readonly unset return exit".split(" "));

/** Match `re` (sticky) at `i`; the matched text, or undefined. */
const at = (re: RegExp, text: string, i: number): string | undefined => {
  re.lastIndex = i;
  return re.exec(text)?.[0];
};

const SHELL_TOKEN = {
  comment: /#.*/y,
  string: /"(?:[^"\\]|\\.)*"?|'[^']*'?/y,
  variable: /\$(?:\{[^}]*\}?|[A-Za-z_][A-Za-z0-9_]*|[0-9@#?$!*-])/y,
  flag: /--?[A-Za-z0-9][A-Za-z0-9_-]*/y,
  operator: /&&|\|\||>>|<<|[|;&<>()]/y,
  word: /[^\s"'$|;&<>()#]+/y,
};

function shell(line: string): string {
  let out = "";
  let i = 0;
  // The first word of a command (at the start of a line or after | ; && ||) is the program being run.
  let command = true;
  while (i < line.length) {
    const ch = line[i]!;
    if (/\s/.test(ch)) {
      out += ch;
      i++;
      continue;
    }
    let m: string | undefined;
    if (ch === "#" && (i === 0 || /\s/.test(line[i - 1]!)) && (m = at(SHELL_TOKEN.comment, line, i))) out += color.comment(m);
    else if ((m = at(SHELL_TOKEN.string, line, i)) && (ch === '"' || ch === "'")) {
      // "$VAR" inside double quotes stays one string: it is still read as a string
      out += color.string(m);
      command = false;
    } else if (ch === "$" && (m = at(SHELL_TOKEN.variable, line, i))) out += color.variable(m);
    else if ((ch === "-" && (m = at(SHELL_TOKEN.flag, line, i))) && !command) out += color.flag(m);
    else if ((m = at(SHELL_TOKEN.operator, line, i))) {
      out += color.punct(m);
      if (/^(\||;|&&|\|\||\()$/.test(m)) command = true;
    } else if ((m = at(SHELL_TOKEN.word, line, i))) {
      if (SHELL_KEYWORDS.has(m)) out += color.keyword(m);
      else if (command && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(m)) {
        out += st.bold(color.command(m));
        command = false;
      } else out += m;
    } else {
      m = ch;
      out += ch;
    }
    i += m.length;
  }
  return out;
}

const JSON_TOKEN = /("(?:[^"\\]|\\.)*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false|null)\b/g;

function json(line: string): string {
  let out = "";
  let last = 0;
  for (const m of line.matchAll(JSON_TOKEN)) {
    out += line.slice(last, m.index);
    last = m.index + m[0].length;
    if (m[1]) out += m[2] ? `${color.key(m[1])}${color.punct(m[2])}` : color.string(m[1]);
    else if (m[3]) out += color.number(m[3]);
    else out += color.keyword(m[4]!);
  }
  return out + line.slice(last);
}

const SCRIPT_TOKEN = /(\/\/.*|#.*|--.*)|("(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?|`(?:[^`\\]|\\.)*`?)|(\b\d[\d_]*(?:\.\d+)?\b)|([A-Za-z_$][\w$]*)|(\/\*.*?(?:\*\/|$))/g;

function script(line: string, lang: string | undefined, state: { block: boolean }): string {
  if (state.block) {
    const end = line.indexOf("*/");
    if (end < 0) return color.comment(line);
    state.block = false;
    return color.comment(line.slice(0, end + 2)) + script(line.slice(end + 2), lang, state);
  }
  let out = "";
  let last = 0;
  for (const m of line.matchAll(SCRIPT_TOKEN)) {
    const [text, comment, string, number, word, block] = m;
    // `#` and `--` start a comment only where the language says so (and `#` is a prefix in C-like code, e.g. #include)
    const hashOk = text.startsWith("#") ? ["py", "python", "rb", "ruby", "yaml", "yml", "toml", "sh", "bash"].includes(lang ?? "") : true;
    const dashOk = text.startsWith("--") ? ["sql", "lua"].includes(lang ?? "") : true;
    out += line.slice(last, m.index);
    last = m.index + text.length;
    if (comment && hashOk && dashOk) out += color.comment(text);
    else if (comment) out += text;
    else if (string) out += color.string(text);
    else if (number) out += color.number(text);
    else if (block) {
      out += color.comment(text);
      if (!text.endsWith("*/")) state.block = true;
    } else if (word) out += KEYWORDS.has(word) ? color.keyword(word) : /^[A-Z][A-Za-z0-9]*$/.test(word) ? color.type(word) : word;
    else out += text;
  }
  return out + line.slice(last);
}

function diffLine(line: string): string {
  if (/^(\+\+\+|---) /.test(line) || /^(diff |index )/.test(line)) return st.bold(line);
  if (line.startsWith("@@")) return color.command(line);
  if (line.startsWith("+")) return st.green(line);
  if (line.startsWith("-")) return st.red(line);
  return line;
}

/** `code` as ANSI-coloured lines. `lang` is a fence language or extension; anything unknown stays plain. */
export function highlight(code: string, lang?: string): string[] {
  const family = languageOf(lang);
  const lines = code.split("\n");
  if (!family) return lines;
  if (family === "shell") return lines.map((l) => (/^\s*\$ /.test(l) ? l.replace(/^(\s*)\$ (.*)$/, (_, pad: string, rest: string) => `${pad}${color.punct("$")} ${shell(rest)}`) : shell(l)));
  if (family === "json") return lines.map(json);
  if (family === "diff") return lines.map(diffLine);
  const state = { block: false };
  const name = lang!.toLowerCase().replace(/^\./, "");
  return lines.map((l) => script(l, name, state));
}
