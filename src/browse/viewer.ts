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
 *   /        search the messages: free words, all in one message (tool output only with `o`); the list narrows to the
 *            messages that hold them and every hit is highlighted. n/N next/previous hit (in the content pane, a line
 *            at a time and then message by message), x clears. Opened from a search in the session list, the viewer
 *            starts on the first hit with the words highlighted but the list not narrowed.
 *   v        cycle the list: prompts → conversation → everything           V  as a dialog, plus layout
 *            settings that persist: indent replies under their prompt, tool calls one level deeper, and whether rows are
 *            marked with an icon (❯) or the kind's name ([User])
 */
import { formatBytes } from "../format.js";
import { latestShare, sharesFor } from "../sessions/shares.js";
import type { SessionSummary } from "../sessions/summary.js";
import { branchLabel, plural, shortModel } from "./display.js";
import { RadioDialog, type DialogSection } from "./dialogs.js";
import { HARNESS_META } from "../harnesses/meta.js";
import { cut, elide, fit, frame, isKey, isPlain, isShift, padLines, pagingKey, st, w, wrap } from "./kit.js";
import { markLine, splitWords, unstyled } from "./mark.js";
import { SAVE_FAILED_MESSAGE, type MarkerStyle, type SettingsStore } from "./settings.js";
import { renderItem } from "./render.js";
import { Spinner } from "./spinner.js";
import type { ShareSummary, SessionView, Source, ViewBlock, ViewItem, ViewKind } from "./source.js";

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
/** Lines of the message kept above a hit that `n` / `N` brings into view. */
const HIT_MARGIN = 2;

/**
 * What a search reads in a message, lower-cased once: its list row and the text its content pane draws, with a tool's or
 * subagent's output kept apart so it can be left out. Messages with blocks are read from the blocks, not from `body`:
 * the pane draws more of a long edit or file than `body` keeps, and a search must find what is on screen.
 */
interface Haystack {
  inputs: string;
  all: string;
}
const haystacks = new WeakMap<ViewItem, Haystack>();
/** Headings the pane puts between the parts of a tool call: layout, not words. */
const LAYOUT_LABEL = /^(?:input|result|error|task)$/;
const textsOf = (b: ViewBlock): string[] => (b.type === "edit" ? [b.path ?? "", ...b.edits.flatMap((e) => [e.old, e.new])] : b.type === "label" && LAYOUT_LABEL.test(b.text) ? [] : [b.text]);
function haystack(it: ViewItem): Haystack {
  let h = haystacks.get(it);
  if (!h) {
    const call = [it.label];
    const output: string[] = [];
    if (it.blocks?.length) for (const b of it.blocks) (b.output ? output : call).push(...textsOf(b));
    else call.push(it.body);
    const inputs = call.join("\n").toLowerCase();
    haystacks.set(it, (h = { inputs, all: [inputs, ...output.map((t) => t.toLowerCase())].join("\n") }));
  }
  return h;
}
const holds = (text: string, words: readonly string[]): boolean => words.every((word) => text.includes(word));

/** The content pane's lines for a message with the search's hits marked, and which lines hold one. */
interface Laid {
  key: string;
  lines: string[];
  hitLines: number[];
  hits: number;
}

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
  /**
   * The search: free words, all in one message. `filtering` narrows the list to the messages holding them; words handed
   * over from the session list only highlight, so opening a session never hides messages the user did not ask to hide.
   */
  private query: string;
  private words: string[];
  private filtering = false;
  private typing = false;
  /** Whether a tool's or subagent's result counts as part of a message when searching (`o`). */
  private includeOutput = false;
  /** Where to put the content pane at the next draw, once the message is laid out and its hits are known. */
  private jump?: "first" | "last";
  /** The content line `n` / `N` last moved to. */
  private hitLine = -1;
  private laid = new WeakMap<ViewItem, Laid>();
  /** Rendering (markdown above all) does not depend on the search, so typing more of a query only marks lines again. */
  private rendered = new WeakMap<ViewItem, { width: number; lines: string[] }>();
  private hitNote = "";
  private paneWidth = 0;
  private hitSets?: { view: SessionView; key: string; inputs: Set<ViewItem>; all: Set<ViewItem> };

  constructor(
    readonly session: SessionSummary,
    private source: Source,
    private hooks: ViewerHooks,
    /** Free words from the session list's search: highlighted, and the viewer starts on the first message holding them. */
    query = "",
  ) {
    this.query = query;
    this.words = splitWords(query);
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
      (view) =>
        arrived(() => {
          this.view = view;
          this.startOnFirstHit();
        }),
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
    const listed = (this.view?.items ?? []).filter((i) => kinds.includes(i.kind));
    return this.filtering && this.words.length ? listed.filter((i) => this.isHit(i)) : listed;
  }

  /** The messages that hold every word, with and without tool output. Memoised: finding them reads every message. */
  private hits(): { inputs: Set<ViewItem>; all: Set<ViewItem> } {
    const view = this.view!;
    const key = this.words.join(" ");
    if (this.hitSets?.view !== view || this.hitSets.key !== key) {
      const inputs = new Set<ViewItem>();
      const all = new Set<ViewItem>();
      for (const it of view.items) {
        const h = haystack(it);
        if (!holds(h.all, this.words)) continue;
        all.add(it);
        if (holds(h.inputs, this.words)) inputs.add(it);
      }
      this.hitSets = { view, key, inputs, all };
    }
    return this.hitSets;
  }

  private isHit(it: ViewItem): boolean {
    return this.words.length > 0 && !!this.view && (this.includeOutput ? this.hits().all : this.hits().inputs).has(it);
  }

  /** Run `change`, then stay on the same message if it is still listed, otherwise on the next one after it. */
  private reselect(change: () => void): void {
    const before = this.items[this.cursor];
    change();
    const items = this.items;
    if (before && this.view) {
      const all = this.view.items;
      const at = all.indexOf(before);
      const next = items.findIndex((i) => all.indexOf(i) >= at);
      this.cursor = next >= 0 ? next : Math.max(0, items.length - 1);
    } else this.cursor = 0;
    this.show();
  }

  /** A different message is selected: its content starts at the top, or at its first hit when there is a search. */
  private show(): void {
    this.scroll = 0;
    this.hitLine = -1;
    this.jump = this.words.length ? "first" : undefined;
  }

  private setLevel(level: number): void {
    this.reselect(() => {
      this.level = level;
    });
  }

  /** The words arrived with the viewer: start on the first message that holds them. */
  private startOnFirstHit(): void {
    const first = this.words.length ? this.items.findIndex((it) => this.isHit(it)) : -1;
    if (first < 0) return;
    this.cursor = first;
    this.show();
  }

  /** Typing in the search box: the list narrows with every key, and the first match is selected. */
  private editQuery(text: string): void {
    const words = splitWords(text);
    if (words.length) {
      this.query = text;
      this.words = words;
      this.filtering = true;
      this.cursor = 0;
      this.show();
    } else {
      // Nothing left to search for: the whole list is back, and the selection stays where it was.
      this.reselect(() => {
        this.query = text;
        this.words = [];
        this.filtering = false;
      });
    }
  }

  private clearSearch(): void {
    this.typing = false;
    this.reselect(() => {
      this.query = "";
      this.words = [];
      this.filtering = false;
    });
  }

  /** `/`: edit the search the user typed here, or start a new one over words that only came from the session list (they stay highlighted until the first key). */
  private startTyping(): void {
    this.typing = true;
    if (!this.filtering) this.query = "";
  }

  private typingKey(data: string): void {
    if (isKey(data, "enter") || isKey(data, "down")) this.typing = false;
    else if (isKey(data, "escape")) this.clearSearch();
    else if (isKey(data, "backspace")) this.editQuery(this.query.slice(0, -1));
    else if (isKey(data, "ctrl+u")) this.editQuery("");
    else if (!data.startsWith("\x1b") && data >= " ") this.editQuery(this.query + data);
  }

  /**
   * `n` / `N`. In the content pane: the next or previous line with a hit in this message, and past its last one the next
   * message that holds the words. In the list: the next or previous such message.
   */
  private step(dir: 1 | -1): void {
    if (!this.words.length || !this.view) return;
    const items = this.items;
    const here = items[this.cursor];
    if (this.pane === "content" && here && this.paneWidth) {
      const lines = this.layout(here, this.paneWidth).hitLines;
      const next = dir > 0 ? lines.find((l) => l > this.hitLine) : [...lines].reverse().find((l) => l < this.hitLine);
      if (next !== undefined) {
        this.hitLine = next;
        this.scroll = Math.max(0, next - HIT_MARGIN);
        return;
      }
    }
    let i = this.cursor + dir;
    while (i >= 0 && i < items.length && !this.isHit(items[i]!)) i += dir;
    if (i < 0 || i >= items.length) return this.hooks.notify(dir > 0 ? "no later message holds the words" : "no earlier message holds the words");
    this.cursor = i;
    this.show();
    if (dir < 0) this.jump = "last";
  }

  /** `o`: whether a tool call's or subagent's result counts when searching. */
  private toggleOutput(): void {
    this.reselect(() => {
      this.includeOutput = !this.includeOutput;
    });
    this.hooks.notify(this.includeOutput ? "searching tool output too" : "searching without tool output");
  }

  /** Which pane the movement keys drive. */
  get focus(): Pane {
    return this.pane;
  }

  onKey(data: string): void {
    if (this.typing) return this.typingKey(data);
    const items = this.items;
    const move = (to: number) => {
      this.cursor = Math.max(0, Math.min(items.length - 1, to));
      this.show();
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
    if (isKey(data, "escape") || isKey(data, "q") || isKey(data, "left") || isKey(data, "h")) {
      // A search the user typed goes first; one handed over from the session list is not in the way of leaving.
      if (this.filtering) return this.clearSearch();
      return this.hooks.close();
    }
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
    else if (data === "/" && this.view) this.startTyping();
    else if (isPlain(data, "n")) this.step(1);
    else if (isShift(data, "n")) this.step(-1);
    else if (isPlain(data, "o") && this.words.length) this.toggleOutput();
    else if (isPlain(data, "x") && this.words.length) this.clearSearch();
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
    if (this.typing) return [["enter", "done"], ["esc", "clear"]];
    const search: Array<[string, string]> = [["/", "search"], ...(this.words.length ? ([["n/N", "next/prev hit"], ["o", "tool output"], ["x", "clear search"]] as Array<[string, string]>) : [])];
    return this.pane === "content"
      ? [["j/k", "scroll"], ...search, ["space/b", "page"], ["g/G", "top/bottom"], ["J/K", "prompt"], ["y", "copy"], ["tab/esc", "back to list"], ["p", "publish"]]
      : [["j/k", "message"], ...search, ["space/b", "page"], ["J/K", "prompt"], ["enter/tab", "read"], ["y", "copy"], ["v", "list level"], ["V", "view options"], ["p", "publish"], ["esc", "back"]];
  }

  /** The search box and what it found, under the header while there is a search: how many messages hold the words, and where else some do. */
  private searchLine(width: number): string | undefined {
    if (!this.typing && !this.query) return undefined;
    const box = `${st.cyan("/")} ${this.query}${this.typing ? st.inv(" ") : ""}`;
    if (!this.words.length || !this.view) return cut(this.typing ? `${box}${st.dim("   words to find, all in one message")}` : box, width);
    const { inputs, all } = this.hits();
    const kinds = LEVELS[this.level]!.kinds as readonly ViewKind[];
    const shown = this.view.items.filter((i) => kinds.includes(i.kind));
    const found = shown.filter((i) => this.isHit(i)).length;
    const elsewhere = this.view.items.filter((i) => !kinds.includes(i.kind) && this.isHit(i)).length;
    const output = this.includeOutput ? 0 : shown.filter((i) => all.has(i) && !inputs.has(i)).length;
    const notes = [
      found ? plural(found, "message") : "no message",
      this.includeOutput && "tool output included",
      elsewhere > 0 && `+${elsewhere} in hidden kinds (v)`,
      output > 0 && `+${output} in tool output (o)`,
    ].filter(Boolean);
    return cut(`${box}${st.dim(`   ${notes.join(" · ")}`)}`, width);
  }

  private header(width: number): string[] {
    const s = this.session;
    const v = this.view;
    const lines = [`${st.bold("overshare")}  ${st.dim("›")}  ${st.bold(cut(s.title ?? "(untitled)", width - 20))}`];
    lines.push(cut(st.dim([HARNESS_META[s.harness].label, s.project, branchLabel(s), s.models.map(shortModel).join(", ")].filter(Boolean).join(" · ")), width));
    const last = latestShare(this.source.shares, s.harness, s.id);
    if (last) {
      const label = `✓ shared (${last.record.mode})${last.earlier ? ` · +${last.earlier} earlier` : ""}  `;
      lines.push(cut(`${st.green(label)}${st.cyan(elide(last.link, width - w(label)))}`, width));
    }
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
    const search = this.searchLine(width);
    if (search) lines.push(search);
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
      const lead = `${i === this.cursor ? (listActive ? st.cyan("▌") : st.gray("▌")) : " "}${" ".repeat(this.depth(it.kind) * INDENT)}`;
      let row = `${lead}${marker(it, `${turn}${it.error ? st.red(it.label) : it.label}`, markers)}`;
      if (this.words.length) {
        // The row shows one line of the message; the hits the message holds in all (what its pane highlights) are the part that may be out of sight.
        const n = this.isHit(it) ? this.layout(it, rightW - 4).hits : 0;
        const badge = n ? st.dim(` ×${n}`) : "";
        // Cut first and mark what is left, so a word the cut runs through is not half-highlighted; the marker, the turn number and the indent were not searched.
        row = markLine(fit(row, rowW - w(badge)), this.words, unstyled(`${lead}${marker(it, turn, markers)}`).length).line + badge;
      }
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
    const laid = this.layout(it, width);
    this.rightLines = laid.lines;
    this.rightHeight = height;
    this.paneWidth = width;
    this.hitNote = laid.hits ? `${plural(laid.hits, "hit")} · n/N` : "";
    if (this.jump) {
      const line = this.jump === "last" ? laid.hitLines.at(-1) : laid.hitLines[0];
      this.hitLine = line ?? -1;
      // The first hit only moves the pane when it is out of sight; stepping to a hit always puts it near the top.
      if (line !== undefined) this.scroll = this.jump === "first" && line < height ? 0 : Math.max(0, line - HIT_MARGIN);
      this.jump = undefined;
    }
    this.scroll = Math.min(this.scroll, this.maxScroll());
    return { title, lines: this.rightLines.slice(this.scroll, this.scroll + height), bottom: this.rightHint() };
  }

  /** A message's lines as the content pane draws them, with the search's hits marked; kept while the words and the width stay the same. */
  private layout(it: ViewItem, width: number): Laid {
    const key = `${width}\0${this.words.join(" ")}`;
    let laid = this.laid.get(it);
    if (laid?.key !== key) {
      const hitLines: number[] = [];
      let hits = 0;
      let base = this.rendered.get(it);
      if (base?.width !== width) this.rendered.set(it, (base = { width, lines: renderItem(it, width) }));
      const lines = base.lines.map((line, i) => {
        const marked = markLine(line, this.words);
        if (marked.hits) {
          hitLines.push(i);
          hits += marked.hits;
        }
        return marked.line;
      });
      this.laid.set(it, (laid = { key, lines, hitLines, hits }));
    }
    return laid;
  }

  /** What the content panel's bottom border says: the hits, how much is hidden, and how to move the focus. */
  private rightHint(): string | undefined {
    const more = this.rightLines.length - this.rightHeight - this.scroll;
    const hidden = more > 0 ? `↓ ${more} more lines` : "";
    if (this.pane === "content") return [this.hitNote, hidden, "j/k scroll", "space/b page", "y copy", "tab/esc back"].filter(Boolean).join(" · ");
    return more > 0 ? `${[this.hitNote, hidden].filter(Boolean).join(" · ")} · enter to read` : this.hitNote || undefined;
  }
}
