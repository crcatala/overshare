/**
 * Terminal scaffolding for the browser over @earendil-works/pi-tui: one full-screen `Screen` component that
 * draws exactly `rows` lines, string helpers (styles, padding, columns, boxes, overlays), and `runScreen`,
 * which owns the terminal lifecycle so a crash can never leave the shell in a broken input mode.
 */
import {
  matchesKey,
  ProcessTerminal,
  sliceByColumn,
  stripTerminalSequences,
  truncateToWidth,
  TuiAltScreen,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type KeyId,
} from "@earendil-works/pi-tui";
import { stripControls } from "../sanitize.js";

const sgr = (open: string, close = "0") => (s: string): string => `\x1b[${open}m${s}\x1b[${close}m`;
export const st = {
  dim: sgr("2", "22"),
  bold: sgr("1", "22"),
  inv: sgr("7", "27"),
  red: sgr("31", "39"),
  green: sgr("32", "39"),
  yellow: sgr("33", "39"),
  blue: sgr("34", "39"),
  magenta: sgr("35", "39"),
  cyan: sgr("36", "39"),
  gray: sgr("90", "39"),
  /**
   * Selected-row background. Truncation (and any inner style) can emit a full reset, `\x1b[0m`, which would also
   * clear this background for the rest of the row, so the background is re-applied after every reset.
   */
  sel: (s: string): string => `\x1b[48;5;238m${s.replace(/\x1b\[(?:0?|49)m/g, (reset) => `${reset}\x1b[48;5;238m`)}\x1b[49m`,
  /** Selected row in a pane that does not have the keyboard focus. */
  selDim: (s: string): string => `\x1b[48;5;236m${s.replace(/\x1b\[(?:0?|49)m/g, (reset) => `${reset}\x1b[48;5;236m`)}\x1b[49m`,
  /** The hotkey letter inside a label: bold + underline, without touching colours or backgrounds. */
  hot: (s: string): string => `\x1b[1;4m${s}\x1b[22;24m`,
  chip: (s: string): string => `\x1b[48;5;24m\x1b[38;5;255m ${s} \x1b[0m`,
  chipOff: (s: string): string => `\x1b[48;5;236m\x1b[38;5;245m ${s} \x1b[0m`,
  key: (s: string): string => `\x1b[38;5;110m${s}\x1b[39m`,
};

export const w = visibleWidth;
export const plainText = stripTerminalSequences;
/** Truncate with an ellipsis and pad to exactly `n` columns. */
export const fit = (s: string, n: number): string => (n <= 0 ? "" : truncateToWidth(s, n, "…", true));
/** Truncate only. */
export const cut = (s: string, n: number): string => (n <= 0 ? "" : truncateToWidth(s, n, "…"));
export const wrap = (s: string, n: number): string[] => (n <= 0 ? [] : wrapTextWithAnsi(s, n));
/** Shorten plain text to `n` columns by cutting out its middle, so both ends stay readable (a link's host and its id's tail). */
export function elide(s: string, n: number): string {
  if (w(s) <= n) return s;
  if (n <= 2) return cut(s, n);
  const chars = Array.from(s);
  const room = n - 1;
  let head = "";
  for (const c of chars) {
    if (w(head + c) > Math.ceil(room / 2)) break;
    head += c;
  }
  let tail = "";
  for (let i = chars.length - 1; i >= 0 && w(head) + w(chars[i]! + tail) <= room; i--) tail = chars[i]! + tail;
  return `${head}…${tail}`;
}
export const padLines = (lines: string[], n: number): string[] => lines.concat(Array.from({ length: Math.max(0, n - lines.length) }, () => ""));
export const isKey = (data: string, key: string): boolean => matchesKey(data, key as KeyId);

/** A lowercase key pressed without Shift. (Terminals report Shift+r either as "R" or as a modifier sequence.) */
export const isPlain = (data: string, key: string): boolean => data !== key.toUpperCase() && isKey(data, key) && !isKey(data, `shift+${key}`);
/** Shift + a letter. */
export const isShift = (data: string, key: string): boolean => data === key.toUpperCase() || isKey(data, `shift+${key}`);

const PASTE = /^\x1b\[200~([\s\S]*)\x1b\[201~$/;

/**
 * What a key adds to a one-line text box: a printable key as is, or a paste (pi-tui hands one over whole, wrapped in
 * bracketed-paste markers) on one line with its controls stripped. Undefined for any other key.
 */
export function typedText(data: string): string | undefined {
  const paste = PASTE.exec(data);
  // Trim last: an escape sequence after the trailing newline would otherwise keep the space it became.
  if (paste) return stripControls(paste[1]!.replace(/[\r\n\t]+/g, " ")).trim();
  return !data.startsWith("\x1b") && data >= " " ? data : undefined;
}

/** A page-sized move: `fraction` of the visible rows, up or down. */
export interface PageMove {
  dir: 1 | -1;
  fraction: number;
}

/**
 * The paging keys every scrollable pane shares: space, PgDn, ctrl-f / b, PgUp, ctrl-b a full page,
 * ctrl-d / ctrl-u half a page. (`space`/`b` need no modifier, and ctrl-b is tmux's prefix.)
 */
export function pagingKey(data: string): PageMove | undefined {
  if (isKey(data, "pageDown") || isKey(data, "ctrl+f") || isKey(data, "space")) return { dir: 1, fraction: 1 };
  if (isKey(data, "pageUp") || isKey(data, "ctrl+b") || isPlain(data, "b")) return { dir: -1, fraction: 1 };
  if (isKey(data, "ctrl+d")) return { dir: 1, fraction: 0.5 };
  if (isKey(data, "ctrl+u")) return { dir: -1, fraction: 0.5 };
  return undefined;
}

/** Join two blocks side by side; each gets a fixed width. */
export function columns(left: string[], right: string[], lw: number, rw: number, sep = " │ "): string[] {
  const n = Math.max(left.length, right.length);
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(`${fit(left[i] ?? "", lw)}${st.gray(sep)}${fit(right[i] ?? "", rw)}`);
  return out;
}

export function hr(width: number, label = ""): string {
  const l = label ? ` ${label} ` : "";
  return st.gray(`${"─".repeat(2)}${l}${"─".repeat(Math.max(0, width - 2 - w(l)))}`);
}

/** A bordered box of `inner` lines with a title, exactly `width` columns wide. */
export function box(title: string, inner: string[], width: number): string[] {
  const iw = Math.max(0, width - 4);
  const top = st.gray("╭─ ") + st.bold(cut(title, iw - 2)) + st.gray(` ${"─".repeat(Math.max(0, width - 5 - Math.min(w(title), iw - 2)))}╮`);
  const body = inner.map((l) => `${st.gray("│")} ${fit(l, iw)} ${st.gray("│")}`);
  return [top, ...body, st.gray(`╰${"─".repeat(Math.max(0, width - 2))}╯`)];
}

/**
 * A rounded panel exactly `width` columns wide, with `title` set into the top border and an optional right-aligned
 * `bottom` label in the bottom border (lazygit/lazydocker style). The active panel draws a bright border and a bold
 * title; an inactive one is gray. `inner` lines are fitted to the inside (`width - 2` columns), so callers add their own padding.
 */
export function frame(title: string, inner: string[], width: number, opts: { active: boolean; bottom?: string }): string[] {
  const edge = opts.active ? st.cyan : st.gray;
  const iw = Math.max(0, width - 2);
  const t = title ? ` ${cut(title, Math.max(0, iw - 3))} ` : "";
  const top = `${edge("╭─")}${opts.active ? st.bold(t) : t}${edge(`${"─".repeat(Math.max(0, iw - 1 - w(t)))}╮`)}`;
  const body = inner.map((l) => `${edge("│")}${fit(l, iw)}${edge("│")}`);
  const b = opts.bottom ? ` ${cut(opts.bottom, Math.max(0, iw - 3))} ` : "";
  const bottom = edge(`╰${"─".repeat(Math.max(0, iw - 1 - w(b)))}`) + (opts.active ? b : st.dim(b)) + edge("─╯");
  return [top, ...body, bottom];
}

/** Paint `overlay` lines centred over `base`, dimming everything behind so it reads as modal. */
export function composite(base: string[], overlay: string[], width: number): string[] {
  const ow = Math.min(width, Math.max(...overlay.map(w)));
  const left = Math.max(0, Math.floor((width - ow) / 2));
  const top = Math.max(0, Math.floor((base.length - overlay.length) / 2));
  const dimmed = base.map((l) => st.gray(stripTerminalSequences(fit(l, width))));
  return dimmed.map((line, i) => {
    const o = overlay[i - top];
    if (o === undefined) return line;
    return st.gray(sliceByColumn(line, 0, left)) + fit(o, ow) + st.gray(sliceByColumn(line, left + ow, Math.max(0, width - left - ow)));
  });
}

/**
 * Undo every terminal mode pi-tui (or a crash) may have left on. Safe to call repeatedly, and safe when pi-tui
 * already restored things. Without it an uncaught exception leaves the Kitty keyboard protocol and modifyOtherKeys
 * on, and the shell then prints raw key codes (e.g. `ctrl+r` as `114;5u`).
 */
export function emergencyRestore(out: { isTTY?: boolean; write(s: string): unknown } = process.stdout): void {
  if (!out.isTTY) return;
  try {
    out.write(
      [
        "\x1b[<u\x1b[<u\x1b[<u", // pop the Kitty keyboard protocol stack (pi-tui pushes at startup)
        "\x1b[>4;0m", // modifyOtherKeys off
        "\x1b[?2004l", // bracketed paste off
        "\x1b[?1006l\x1b[?1004l\x1b[?1003l\x1b[?1002l\x1b[?1000l", // mouse tracking off
        "\x1b[?25h", // show the cursor
        "\x1b[0m", // reset attributes
        "\x1b[?1049l", // leave the alternate screen
      ].join(""),
    );
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
  } catch {
    // nothing more we can do
  }
}

const errorText = (err: unknown): string => (err instanceof Error ? `${err.name}: ${err.message}` : String(err));

/** One full-screen page: `draw(width, height)` returns exactly `height` lines of at most `width` columns. */
export abstract class Screen implements Component {
  rows = 24;
  /** Last error caught from a key handler or a draw; shown by the screen instead of crashing. */
  lastError?: string;
  /** Set by `runScreen`; called when the screen asks to exit. */
  onQuit: () => void = () => {};
  protected requestRender: () => void = () => {};

  abstract draw(width: number, height: number): string[];
  abstract onKey(data: string): void;

  quit(): void {
    this.onQuit();
  }

  handleInput(data: string): void {
    try {
      this.lastError = undefined;
      this.onKey(data);
    } catch (err) {
      this.lastError = errorText(err);
    }
    this.requestRender();
  }

  render(width: number): string[] {
    let lines: string[];
    try {
      lines = this.draw(width, this.rows);
    } catch (err) {
      this.lastError = errorText(err);
      lines = [st.red(`render error: ${this.lastError}`), st.dim("press esc or q to go back, ctrl-c to quit")];
    }
    return lines.slice(0, this.rows).map((l) => (w(l) > width ? cut(l, width) : l));
  }

  invalidate(): void {}

  attach(rows: () => number, requestRender: () => void): void {
    this.requestRender = requestRender;
    Object.defineProperty(this, "rows", { get: rows, configurable: true });
  }
}

/** Run a screen full-screen until it quits; resolves the process exit only after the terminal is restored. */
export function runScreen(screen: Screen): void {
  const terminal = new ProcessTerminal();
  // Mouse capture stays off so the terminal's own text selection keeps working.
  const tui = new TuiAltScreen(terminal, false, undefined, { mouse: false });
  screen.attach(() => terminal.rows, () => tui.requestRender());
  tui.addChild(screen);
  tui.setFocus(screen);
  let done = false;
  const shutdown = (code: number, failure?: unknown) => {
    if (done) return;
    done = true;
    try {
      // pi-tui's default stop() replays the last frame onto the main screen after leaving the alt screen,
      // which strands the TUI's final view in the user's scrollback. We want the shell back untouched.
      tui.stop({ preserveScreen: true });
    } catch {
      // fall through to the hard reset
    }
    emergencyRestore();
    if (failure !== undefined) console.error(`\novershare browse crashed: ${failure instanceof Error ? (failure.stack ?? failure.message) : String(failure)}`);
    process.exit(code);
  };
  screen.onQuit = () => shutdown(0);
  // Whatever goes wrong, hand the terminal back in a sane state.
  process.on("uncaughtException", (err) => shutdown(1, err));
  process.on("unhandledRejection", (err) => shutdown(1, err));
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(sig, () => shutdown(0));
  process.on("exit", () => emergencyRestore());
  tui.addInputListener((data) => {
    if (matchesKey(data, "ctrl+c")) {
      shutdown(0);
      return { consume: true };
    }
    return undefined;
  });
  tui.start();
}
