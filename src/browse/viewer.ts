/**
 * Session viewer: the left pane is a navigable list of messages, the right pane is the selected message in
 * full. The header shows stats, the tool-call breakdown and the redaction status of a brief share.
 *
 *   j/k ↑/↓  message         J/K  next/previous prompt        g/G  first/last
 *   v        cycle the list: prompts → conversation → everything           V  as a dialog
 *   space / ctrl-d / ctrl-u  scroll the content pane           p  publish        esc  back
 */
import { formatBytes } from "../format.js";
import { sharesFor } from "../sessions/shares.js";
import type { SessionSummary } from "../sessions/summary.js";
import { plural, shortModel } from "./display.js";
import { RadioDialog } from "./dialogs.js";
import { columns, cut, fit, hr, isKey, padLines, st, wrap } from "./kit.js";
import type { ShareSummary, SessionView, Source, ViewItem, ViewKind } from "./source.js";

export const LEVELS = [
  { label: "user prompts only", hint: "what you asked", kinds: ["user"] as ViewKind[] },
  { label: "user + assistant", hint: "the conversation", kinds: ["user", "assistant"] as ViewKind[] },
  { label: "everything", hint: "tool calls, thinking, skills, subagents, events", kinds: ["user", "assistant", "tool", "thinking", "subagent", "event"] as ViewKind[] },
] as const;

const ICON: Record<ViewKind, (s: string) => string> = {
  user: (s) => `${st.cyan("❯")} ${s}`,
  assistant: (s) => `${st.green("◆")} ${s}`,
  tool: (s) => `${st.yellow("⚙")} ${st.dim(s)}`,
  thinking: (s) => `${st.gray("…")} ${st.gray(s)}`,
  subagent: (s) => `${st.magenta("⛭")} ${st.dim(s)}`,
  event: (s) => `${st.blue("⚑")} ${st.dim(s)}`,
};

export interface ViewerHooks {
  requestRender(): void;
  openDialog(d: RadioDialog): void;
  closeDialog(): void;
  publish(): void;
  close(): void;
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export class SessionViewer {
  view?: SessionView;
  loadError?: string;
  /** Redaction status of a brief share, filled in after the viewer has painted. */
  report?: ShareSummary;
  reportError?: string;
  level = 1;
  private cursor = 0;
  private scroll = 0;
  private listTop = 0;
  private rightLines: string[] = [];
  private rightHeight = 1;
  private timers: Array<ReturnType<typeof setTimeout>> = [];

  constructor(
    readonly session: SessionSummary,
    private source: Source,
    private hooks: ViewerHooks,
  ) {
    // Parsing is synchronous and takes up to ~1 s on very large sessions: paint "reading…" first.
    this.later(10, () => {
      try {
        this.view = source.view(session);
      } catch (err) {
        this.loadError = message(err);
      }
      hooks.requestRender();
      // The redaction scan is a second pass: run it once the viewer is usable.
      this.later(30, () => {
        try {
          this.report = source.review(session, "brief");
        } catch (err) {
          this.reportError = message(err);
        }
        hooks.requestRender();
      });
    });
  }

  private later(ms: number, fn: () => void): void {
    this.timers.push(setTimeout(fn, ms));
  }

  dispose(): void {
    for (const t of this.timers) clearTimeout(t);
  }

  private get items(): ViewItem[] {
    const kinds = LEVELS[this.level]!.kinds as readonly ViewKind[];
    return (this.view?.items ?? []).filter((i) => kinds.includes(i.kind));
  }

  private setLevel(level: number): void {
    const before = this.items[this.cursor];
    this.level = level;
    const items = this.items;
    // Stay on the same message if it is still listed, otherwise on the next one after it.
    if (before && this.view) {
      const all = this.view.items;
      const at = all.indexOf(before);
      const next = items.findIndex((i) => all.indexOf(i) >= at);
      this.cursor = next >= 0 ? next : Math.max(0, items.length - 1);
    } else this.cursor = 0;
    this.scroll = 0;
  }

  onKey(data: string): void {
    const items = this.items;
    const move = (to: number) => {
      this.cursor = Math.max(0, Math.min(items.length - 1, to));
      this.scroll = 0;
    };
    if (isKey(data, "escape") || isKey(data, "q") || isKey(data, "left") || isKey(data, "h")) return this.hooks.close();
    if (isKey(data, "down") || isKey(data, "j")) move(this.cursor + 1);
    else if (isKey(data, "up") || isKey(data, "k")) move(this.cursor - 1);
    else if (data === "J" || isKey(data, "shift+j")) {
      const next = items.findIndex((it, i) => i > this.cursor && it.kind === "user");
      move(next >= 0 ? next : items.length - 1);
    } else if (data === "K" || isKey(data, "shift+k")) {
      let i = this.cursor - 1;
      while (i > 0 && items[i]!.kind !== "user") i--;
      move(i);
    } else if (isKey(data, "g") || isKey(data, "home")) move(0);
    else if (data === "G" || isKey(data, "shift+g") || isKey(data, "end")) move(items.length - 1);
    else if (isKey(data, "pageDown") || isKey(data, "ctrl+d") || isKey(data, "space")) this.scroll += 8;
    else if (isKey(data, "pageUp") || isKey(data, "ctrl+u")) this.scroll = Math.max(0, this.scroll - 8);
    else if (isKey(data, "v")) this.setLevel((this.level + 1) % LEVELS.length);
    else if (data === "V" || isKey(data, "shift+v")) {
      this.hooks.openDialog(
        new RadioDialog("Message list", [{ items: LEVELS.map((l, i) => ({ label: l.label, value: i, hint: l.hint })), current: () => this.level, apply: (v) => this.setLevel(v as number) }], {
          onClose: () => this.hooks.closeDialog(),
        }),
      );
    } else if (isKey(data, "p")) this.hooks.publish();
  }

  footerKeys(): Array<[string, string]> {
    return [["j/k", "message"], ["J/K", "prompt"], ["v", "list level"], ["V", "level dialog"], ["space", "scroll"], ["p", "publish"], ["esc", "back"]];
  }

  private header(width: number): string[] {
    const s = this.session;
    const v = this.view;
    const lines = [`${st.bold("agent-share")}  ${st.dim("›")}  ${st.bold(cut(s.title ?? "(untitled)", width - 20))}`];
    lines.push(cut(st.dim([s.harness === "pi" ? "pi" : "Claude Code", s.project, s.branch, s.models.map(shortModel).join(", ")].filter(Boolean).join(" · ")), width));
    if (!v) return lines;
    const d = v.stats;
    lines.push(
      cut(
        st.dim(
          [d.duration, d.cost && `est. ${d.cost}`, `${d.tokens} tokens`, plural(v.turns, "turn"), `files: ${d.files.read} read · ${d.files.edited} edited · ${d.files.written} written`, d.subagents ? plural(d.subagents, "subagent") : ""]
            .filter(Boolean)
            .join("  ·  "),
        ),
        width,
      ),
    );
    const tools = Object.entries(v.tools).sort((a, b) => b[1] - a[1]);
    const total = tools.reduce((n, [, c]) => n + c, 0);
    const toolLine = tools.length ? `${st.cyan(`tools ${total}`)}  ${tools.map(([n, c]) => `${n} ${st.dim(`×${c}`)}`).join(st.gray("  ·  "))}` : st.dim("no tool calls");
    lines.push(...wrap(toolLine, width).slice(0, 2));
    const r = this.report;
    lines.push(
      this.reportError
        ? st.yellow(`redaction check unavailable: ${cut(this.reportError, width - 30)}`)
        : !r
          ? st.dim("checking redaction…")
          : r.blocked
            ? st.red("✗ publishing would be blocked: final re-scan found unredacted secrets")
            : r.clean
              ? st.green(`✓ brief share is clean (${formatBytes(r.bytes)})`)
              : st.yellow(`! brief share: ${plural(r.findings.length, "finding")} redacted (${r.findings.slice(0, 3).map((f) => f.rule).join(", ")})`),
    );
    return lines;
  }

  draw(width: number, height: number): string[] {
    const head = this.header(width);
    if (this.loadError) return [...head, "", st.red(`could not read this session: ${this.loadError}`), st.dim("esc to go back")];
    if (!this.view) return [...head, "", st.dim("  reading the session…")];
    const items = this.items;
    const shared = sharesFor(this.source.shares, this.session.harness, this.session.id).length > 0;
    head.push(hr(width, `${LEVELS[this.level]!.label} · ${items.length} of ${this.view.items.length}${shared ? " · shared ✓" : ""}`));
    const bodyH = Math.max(1, height - head.length - 1);
    const lw = Math.max(20, Math.min(width - 14, Math.floor(width * 0.4)));
    const rw = Math.max(10, width - lw - 3);
    this.cursor = Math.min(this.cursor, Math.max(0, items.length - 1));
    if (this.cursor < this.listTop) this.listTop = this.cursor;
    if (this.cursor >= this.listTop + bodyH) this.listTop = this.cursor - bodyH + 1;
    const left = items.slice(this.listTop, this.listTop + bodyH).map((it, k) => {
      const i = this.listTop + k;
      const turn = it.kind === "user" ? st.dim(`#${it.turn} `) : "";
      const row = `${i === this.cursor ? st.cyan("▌") : " "}${ICON[it.kind](`${turn}${it.error ? st.red(it.label) : it.label}`)}`;
      return i === this.cursor ? st.sel(fit(row, lw)) : row;
    });
    const right = this.rightPane(items[this.cursor], rw, bodyH);
    return [...head, ...columns(padLines(left, bodyH), padLines(right, bodyH), lw, rw).slice(0, bodyH), this.scrollRule(width)];
  }

  private rightPane(it: ViewItem | undefined, width: number, height: number): string[] {
    if (!it) return [st.dim("nothing to show")];
    const title = `${it.kind === "user" ? "prompt" : it.kind}${it.meta ? ` · ${it.meta}` : ""}${it.error ? " · error" : ""}  ${st.dim(`turn ${it.turn}`)}`;
    const dimmed = it.kind === "tool" || it.kind === "thinking";
    this.rightLines = [st.cyan(title), "", ...it.body.split("\n").flatMap((l) => (l ? wrap(dimmed ? st.gray(l) : l, width) : [""]))];
    this.rightHeight = height;
    this.scroll = Math.min(this.scroll, Math.max(0, this.rightLines.length - height));
    return this.rightLines.slice(this.scroll, this.scroll + height);
  }

  private scrollRule(width: number): string {
    const more = this.rightLines.length - this.rightHeight - this.scroll;
    return more > 0 ? hr(width, `↓ ${more} more lines · space`) : hr(width);
  }
}
