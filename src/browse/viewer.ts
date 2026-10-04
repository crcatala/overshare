/**
 * Session viewer: the left panel is a navigable list of messages, the right panel is the selected message in
 * full, each in its own rounded frame (the message heading sits in the right panel's top border; the panel with
 * the focus has the bright border). The header shows stats, the tool-call breakdown and the redaction status of
 * a brief share.
 *
 *   Two panes, one has the focus (the list at first): enter / tab / → / l  read the message (focus the content),
 *   esc / tab / ← / h  back to the list. The same movement keys drive whichever pane is focused:
 *   j/k ↑/↓ line · space/PgDn/ctrl-f and b/PgUp/ctrl-b page · ctrl-d/u half page · g/G first/last.
 *   Everywhere: J/K next/previous prompt · y copy the message · p publish. From the list, esc / q / ← / h leaves the viewer.
 *   v        cycle the list: prompts → conversation → everything           V  as a dialog, plus layout
 *            settings that persist: indent replies under their prompt, tool calls one level deeper, and whether rows are
 *            marked with an icon (❯) or the kind's name ([User])
 */
import { formatBytes } from "../format.js";
import { sharesFor } from "../sessions/shares.js";
import type { SessionSummary } from "../sessions/summary.js";
import { branchLabel, plural, shortModel } from "./display.js";
import { RadioDialog, type DialogSection } from "./dialogs.js";
import { cut, fit, frame, isKey, padLines, pagingKey, st, wrap } from "./kit.js";
import { SAVE_FAILED_MESSAGE, type MarkerStyle, type SettingsStore } from "./settings.js";
import { renderItem } from "./render.js";
import { Spinner } from "./spinner.js";
import type { ShareSummary, SessionView, Source, ViewItem, ViewKind } from "./source.js";

export const LEVELS = [
  { label: "user prompts only", hint: "what you asked", kinds: ["user"] as ViewKind[] },
  { label: "user + assistant", hint: "the conversation", kinds: ["user", "assistant"] as ViewKind[] },
  { label: "everything", hint: "tool calls, thinking, skills, subagents, events", kinds: ["user", "assistant", "tool", "thinking", "subagent", "event"] as ViewKind[] },
] as const;

/** What marks a kind of row in the list, and the colour that kind keeps in the list and in the content pane's heading. */
const KINDS: Record<ViewKind, { icon: string; name: string; color: (s: string) => string; /** Dim the row's text. */ quiet?: "dim" | "gray" }> = {
  user: { icon: "❯", name: "User", color: st.cyan },
  assistant: { icon: "◆", name: "Assistant", color: st.green },
  tool: { icon: "⚙", name: "Tool", color: st.yellow, quiet: "dim" },
  thinking: { icon: "…", name: "Thinking", color: st.gray, quiet: "gray" },
  subagent: { icon: "⛭", name: "Subagent", color: st.magenta, quiet: "dim" },
  event: { icon: "⚑", name: "Event", color: st.blue, quiet: "dim" },
};

/** A loaded skill is an event, but it reads better under its own name. */
const markerName = (it: Pick<ViewItem, "kind" | "meta">): string => (it.kind === "event" && it.meta === "skill" ? "Skill" : KINDS[it.kind].name);

/** The list row's marker and text: `❯ text` with the icon style, `[User] text` with the text style, in the kind's colour. */
export function marker(it: Pick<ViewItem, "kind" | "meta">, text: string, style: MarkerStyle): string {
  const k = KINDS[it.kind];
  const body = k.quiet === "dim" ? st.dim(text) : k.quiet === "gray" ? st.gray(text) : text;
  return `${k.color(style === "text" ? `[${markerName(it)}]` : k.icon)} ${body}`;
}

/** Columns each tree level moves a row to the right. */
const INDENT = 2;

export interface ViewerHooks {
  settings: SettingsStore;
  /** Show a short message in the footer until the next key. */
  notify(message: string): void;
  requestRender(): void;
  openDialog(d: RadioDialog): void;
  closeDialog(): void;
  publish(): void;
  /** Put text on the system clipboard. */
  copy(text: string): void;
  close(): void;
}

export type Pane = "list" | "content";

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export class SessionViewer {
  view?: SessionView;
  loadError?: string;
  /** Redaction status of a brief share, filled in after the viewer has painted. */
  report?: ShareSummary;
  reportError?: string;
  level = 1;
  private pane: Pane = "list";
  private cursor = 0;
  private scroll = 0;
  private listTop = 0;
  private rightLines: string[] = [];
  private rightHeight = 1;
  /** Rows both panes showed on the last draw: the size of a page. */
  private bodyHeight = 10;
  /** Aborted when the viewer closes: the reads still running stop, and what they would have delivered is dropped. */
  private readonly loading = new AbortController();
  private spinner = new Spinner();

  constructor(
    readonly session: SessionSummary,
    private source: Source,
    private hooks: ViewerHooks,
  ) {
    // Both reads run on worker threads, side by side: the list below paints "reading…" at once and the keys keep working.
    const { signal } = this.loading;
    let waiting = 2;
    const arrived = (record: () => void) => {
      if (signal.aborted) return;
      record();
      if (--waiting === 0) this.spinner.stop();
      hooks.requestRender();
    };
    this.spinner.start(() => hooks.requestRender());
    source.view(session, signal).then(
      (view) => arrived(() => void (this.view = view)),
      (err: unknown) => arrived(() => void (this.loadError = message(err))),
    );
    source.review(session, "brief", source.target, signal).then(
      (report) => arrived(() => void (this.report = report)),
      (err: unknown) => arrived(() => void (this.reportError = message(err))),
    );
  }

  dispose(): void {
    this.loading.abort();
    this.spinner.stop();
  }

  /** Tree depth of a row under the persisted layout settings: prompts at 0, replies at 1, tool calls one deeper. */
  private depth(kind: ViewKind): number {
    const { indentReplies, indentTools } = this.hooks.settings.get().viewer;
    if (kind === "user") return 0;
    const replies = indentReplies ? 1 : 0;
    return kind === "assistant" ? replies : replies + (indentTools ? 1 : 0);
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

  /** Which pane the movement keys drive. */
  get focus(): Pane {
    return this.pane;
  }

  onKey(data: string): void {
    const items = this.items;
    const move = (to: number) => {
      this.cursor = Math.max(0, Math.min(items.length - 1, to));
      this.scroll = 0;
    };
    const scrollTo = (to: number) => {
      this.scroll = Math.max(0, Math.min(this.maxScroll(), to));
    };
    const paging = pagingKey(data);
    if (this.pane === "content") {
      // Right pane: the same keys as everywhere, scrolling the message. esc (or h / ←, q) goes back to the list.
      if (isKey(data, "escape") || isKey(data, "q") || isKey(data, "left") || isKey(data, "h") || isKey(data, "tab")) this.pane = "list";
      else if (isKey(data, "down") || isKey(data, "j")) scrollTo(this.scroll + 1);
      else if (isKey(data, "up") || isKey(data, "k")) scrollTo(this.scroll - 1);
      else if (paging) scrollTo(this.scroll + paging.dir * Math.max(1, Math.floor(this.bodyHeight * paging.fraction)));
      else if (isKey(data, "g") || isKey(data, "home")) scrollTo(0);
      else if (data === "G" || isKey(data, "shift+g") || isKey(data, "end")) scrollTo(this.maxScroll());
      else this.sharedKey(data, items, move);
      return;
    }
    if (isKey(data, "escape") || isKey(data, "q") || isKey(data, "left") || isKey(data, "h")) return this.hooks.close();
    if (isKey(data, "enter") || isKey(data, "tab") || isKey(data, "right") || isKey(data, "l")) {
      if (items.length > 0) this.pane = "content";
    } else if (isKey(data, "down") || isKey(data, "j")) move(this.cursor + 1);
    else if (isKey(data, "up") || isKey(data, "k")) move(this.cursor - 1);
    else if (paging) move(this.cursor + paging.dir * Math.max(1, Math.floor(this.bodyHeight * paging.fraction)));
    else if (isKey(data, "g") || isKey(data, "home")) move(0);
    else if (data === "G" || isKey(data, "shift+g") || isKey(data, "end")) move(items.length - 1);
    else this.sharedKey(data, items, move);
  }

  /** Keys that work whichever pane has the focus. */
  private sharedKey(data: string, items: ViewItem[], move: (to: number) => void): void {
    if (data === "J" || isKey(data, "shift+j")) {
      const next = items.findIndex((it, i) => i > this.cursor && it.kind === "user");
      move(next >= 0 ? next : items.length - 1);
    } else if (data === "K" || isKey(data, "shift+k")) {
      let i = this.cursor - 1;
      while (i > 0 && items[i]!.kind !== "user") i--;
      move(i);
    } else if (isKey(data, "v")) this.setLevel((this.level + 1) % LEVELS.length);
    else if (data === "V" || isKey(data, "shift+v")) this.hooks.openDialog(this.viewDialog());
    else if (isKey(data, "y")) this.copyMessage(items[this.cursor]);
    else if (isKey(data, "p")) this.hooks.publish();
  }

  /** `y`: the selected message as plain text, the same words the content pane shows (a tool call: its input and result too). */
  private copyMessage(it: ViewItem | undefined): void {
    if (!it) return;
    this.hooks.copy(it.body);
    this.hooks.notify(`copied the message (${plural(it.body.split("\n").length, "line")}, ${formatBytes(Buffer.byteLength(it.body))})`);
  }

  /** The furthest the content pane can scroll, from the last draw. */
  private maxScroll(): number {
    return Math.max(0, this.rightLines.length - this.rightHeight);
  }

  /**
   * `V`: the list level (this session only, same as `v`) plus the layout options, which are saved and apply to every
   * session from now on, whichever level is showing.
   */
  private viewDialog(): RadioDialog {
    const yesNo = [{ label: "yes", value: true }, { label: "no", value: false }];
    const layout = (title: string, key: "indentReplies" | "indentTools"): DialogSection => ({
      title,
      items: yesNo,
      current: () => this.hooks.settings.get().viewer[key],
      apply: (v) => {
        if (!this.hooks.settings.update({ viewer: { [key]: v as boolean } })) this.hooks.notify(SAVE_FAILED_MESSAGE);
      },
    });
    return new RadioDialog(
      "View",
      [
        { title: "Message list", items: LEVELS.map((l, i) => ({ label: l.label, value: i, hint: l.hint })), current: () => this.level, apply: (v) => this.setLevel(v as number) },
        layout("Indent assistant replies", "indentReplies"),
        layout("Indent tool calls further", "indentTools"),
        {
          title: "Row markers",
          items: [
            { label: "icon", value: "icon", hint: "❯ ◆ ⚙" },
            { label: "text", value: "text", hint: "[User] [Tool]" },
          ],
          current: () => this.hooks.settings.get().viewer.markers,
          apply: (v) => {
            if (!this.hooks.settings.update({ viewer: { markers: v as MarkerStyle } })) this.hooks.notify(SAVE_FAILED_MESSAGE);
          },
        },
      ],
      { window: 13, onClose: () => this.hooks.closeDialog() }, // all four sections at once, so none hides below the fold
    );
  }

  footerKeys(): Array<[string, string]> {
    return this.pane === "content"
      ? [["j/k", "scroll"], ["space/b", "page"], ["g/G", "top/bottom"], ["J/K", "prompt"], ["y", "copy"], ["tab/esc", "back to list"], ["p", "publish"]]
      : [["j/k", "message"], ["space/b", "page"], ["J/K", "prompt"], ["enter/tab", "read"], ["y", "copy"], ["v", "list level"], ["V", "view options"], ["p", "publish"], ["esc", "back"]];
  }

  private header(width: number): string[] {
    const s = this.session;
    const v = this.view;
    const lines = [`${st.bold("agent-share")}  ${st.dim("›")}  ${st.bold(cut(s.title ?? "(untitled)", width - 20))}`];
    lines.push(cut(st.dim([s.harness === "pi" ? "pi" : "Claude Code", s.project, branchLabel(s), s.models.map(shortModel).join(", ")].filter(Boolean).join(" · ")), width));
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
          ? st.dim(`${this.spinner.frame} checking redaction…`)
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
    if (!this.view) return [...head, "", st.dim(`  ${this.spinner.frame} reading the session…  (esc to cancel)`)];
    const items = this.items;
    const shared = sharesFor(this.source.shares, this.session.harness, this.session.id).length > 0;
    // Two rounded panels side by side, one row of border above and below: the active one has the bright border.
    const total = Math.max(3, height - head.length);
    const inner = total - 2;
    this.bodyHeight = inner;
    const listActive = this.pane === "list";
    const leftW = Math.max(22, Math.min(width - 17, Math.floor(width * 0.4) + 2));
    const rightW = Math.max(12, width - leftW - 1);
    const rowW = leftW - 2;
    this.cursor = Math.min(this.cursor, Math.max(0, items.length - 1));
    if (this.cursor < this.listTop) this.listTop = this.cursor;
    if (this.cursor >= this.listTop + inner) this.listTop = this.cursor - inner + 1;
    const { markers } = this.hooks.settings.get().viewer;
    const rows = items.slice(this.listTop, this.listTop + inner).map((it, k) => {
      const i = this.listTop + k;
      const turn = it.kind === "user" ? st.dim(`#${it.turn} `) : "";
      const row = `${i === this.cursor ? (listActive ? st.cyan("▌") : st.gray("▌")) : " "}${" ".repeat(this.depth(it.kind) * INDENT)}${marker(it, `${turn}${it.error ? st.red(it.label) : it.label}`, markers)}`;
      return i === this.cursor ? (listActive ? st.sel : st.selDim)(fit(row, rowW)) : row;
    });
    const left = frame(`${LEVELS[this.level]!.label} · ${items.length} of ${this.view.items.length}${shared ? " · shared ✓" : ""}`, padLines(rows, inner), leftW, {
      active: listActive,
      bottom: items.length ? `${this.cursor + 1}/${items.length}` : undefined,
    });
    const { title, lines, bottom } = this.rightPane(items[this.cursor], rightW - 4, inner);
    const right = frame(title, padLines(lines.map((l) => ` ${l}`), inner), rightW, { active: !listActive, bottom });
    return [...head, ...left.map((l, i) => `${l} ${right[i] ?? ""}`)];
  }

  /** The message in full, scrolled, plus the heading and the hint for the border of its panel. */
  private rightPane(it: ViewItem | undefined, width: number, height: number): { title: string; lines: string[]; bottom?: string } {
    if (!it) {
      this.rightLines = [];
      this.rightHeight = height;
      return { title: "message", lines: [st.dim("nothing to show")] };
    }
    const title = `${KINDS[it.kind].color(it.kind === "user" ? "prompt" : it.kind)}${it.meta ? ` · ${it.meta}` : ""}${it.error ? " · error" : ""}  ${st.dim(`turn ${it.turn}`)}`;
    this.rightLines = renderItem(it, width);
    this.rightHeight = height;
    this.scroll = Math.min(this.scroll, this.maxScroll());
    return { title, lines: this.rightLines.slice(this.scroll, this.scroll + height), bottom: this.rightHint() };
  }

  /** What the content panel's bottom border says: how much is hidden, and how to move the focus. */
  private rightHint(): string | undefined {
    const more = this.rightLines.length - this.rightHeight - this.scroll;
    const hidden = more > 0 ? `↓ ${more} more lines` : "";
    if (this.pane === "content") return [hidden, "j/k scroll", "space/b page", "y copy", "tab/esc back"].filter(Boolean).join(" · ");
    return more > 0 ? `${hidden} · enter to read` : undefined;
  }
}
