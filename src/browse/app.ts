/**
 * The session browser: list + always-on preview, one-key filter cycles with Shift+key radio dialogs,
 * grouping and sorting, a two-pane session viewer, and a publish dialog.
 *
 *   list      h harness · r repo · t time · s shared · g group · o sort   (x clears filters)
 *             Shift+key opens the same choice as a dialog: H R T S G O     (R: type / to filter the repo list)
 *             space/ctrl-f/PgDn and b/ctrl-b/PgUp page · ctrl-d/ctrl-u half a page · , settings
 *             ctrl-r re-reads sessions written since launch (selection and filters stay)
 *             changing a filter, the search or the sort jumps back to the first session; grouping keeps the selection
 *   search    /  free words plus harness:pi project:x branch:y model:opus tool:Bash since:7d shared:no workers:yes
 *             the free words are highlighted in the rows and the preview; the preview quotes the prompts they were found in
 *   open      enter → viewer (message list ↔ content); v cycles prompts / conversation / everything;
 *             the search's words come along: highlighted, and the viewer starts on the first message that holds them
 *   publish   p → mode (t: target, gist or R2) → review → confirm; yes uploads exactly what was reviewed
 */
import { SHARE_TARGETS } from "../config.js";
import { formatBytes } from "../format.js";
import { stripControls } from "../sanitize.js";
import { formatKnownSources } from "../report.js";
import { HARNESS_META, HARNESS_NAMES, type HarnessName } from "../harnesses/meta.js";
import { SHARE_MODES } from "../schema.js";
import { facet, parseQuery, searchSessions } from "../sessions/query.js";
import { latestShare, sharesFor } from "../sessions/shares.js";
import type { SessionSummary } from "../sessions/summary.js";
import { ago, branchLabel, DATE_FORMATS, dateFormat, dayBucket, durationMs, plural, sessionDuration, shortModel, toolSummary, type DateFormatId } from "./display.js";
import { RadioDialog, type DialogSection } from "./dialogs.js";
import { copyToClipboard, MODE_HINT, PublishFlow } from "./flow.js";
import { box, columns, composite, cut, elide, fit, hr, isKey, isPlain, isShift, padLines, pagingKey, Screen, st, w, wrap, type PageMove } from "./kit.js";
import { markLine, snippet } from "./mark.js";
import { MIN_HIGHLIGHT } from "../sessions/query.js";
import { memorySettings, SAVE_FAILED_MESSAGE, type SettingsPatch, type SettingsStore } from "./settings.js";
import { destinationLabel, type Source } from "./source.js";
import { SessionViewer } from "./viewer.js";

type HarnessFilter = HarnessName | undefined;
type TimeFilter = "24h" | "7d" | "30d" | undefined;
type SharedFilter = boolean | undefined;
export type GroupBy = "none" | "date" | "project" | "harness";
export type SortField = "default" | "updated" | "title" | "project" | "size" | "prompts" | "calls" | "duration";

const TIME_MS = { "24h": 86_400_000, "7d": 604_800_000, "30d": 2_592_000_000 } as const;
const HARNESSES: HarnessFilter[] = [undefined, ...HARNESS_NAMES];
const TIMES: TimeFilter[] = [undefined, "24h", "7d", "30d"];
const SHARED: SharedFilter[] = [undefined, false, true];
const GROUPS: Array<{ id: GroupBy; label: string; hint?: string }> = [
  { id: "none", label: "none", hint: "flat list" },
  { id: "date", label: "date", hint: "Today / Yesterday / This week …" },
  { id: "project", label: "repo" },
  { id: "harness", label: "harness" },
];
const SORTS: Array<{ id: SortField; label: string; hint?: string; natural: "asc" | "desc" }> = [
  { id: "default", label: "default", hint: "recent, or best match when searching", natural: "desc" },
  { id: "updated", label: "last updated", natural: "desc" },
  { id: "title", label: "title", natural: "asc" },
  { id: "project", label: "repo", natural: "asc" },
  { id: "size", label: "file size", natural: "desc" },
  { id: "prompts", label: "prompts", natural: "desc" },
  { id: "calls", label: "model calls", natural: "desc" },
  { id: "duration", label: "duration", natural: "desc" },
];
const SORT_KEY: Record<SortField, (s: SessionSummary) => number | string> = {
  default: (s) => s.mtimeMs,
  updated: (s) => s.mtimeMs,
  title: (s) => (s.title ?? "").toLowerCase(),
  project: (s) => (s.project ?? "").toLowerCase(),
  size: (s) => s.size,
  prompts: (s) => s.prompts,
  calls: (s) => s.calls,
  duration: durationMs,
};

/** Width of the list's branch column, and the narrowest title the list keeps to make room for it. */
/** What `y` can honestly say: OSC 52 asks the terminal to set the clipboard, and nothing reports whether it did. */
const COPIED = "link sent to clipboard (OSC 52)";
const BRANCH_COL = 16;
const MIN_TITLE = 28;
/** Most "matched in prompts" lines the preview shows. */
const MAX_SNIPPETS = 3;

const cycle = <T>(list: T[], current: T): T => list[(list.indexOf(current) + 1) % list.length]!;

type Entry = { header: string } | { idx: number };

export interface BrowserOptions {
  /** Initial search text. */
  query?: string;
  harness?: HarnessName;
  /** Clock, injectable for tests. */
  now?: () => number;
  /** Preferences (confirm-on-quit, date format, viewer layout). In memory unless the caller passes a file-backed store. */
  settings?: SettingsStore;
  /** Where `y` sends a share link or the viewer's selected message; the system clipboard (OSC 52) unless a test says otherwise. */
  copy?: (text: string) => void;
}

export class BrowserApp extends Screen {
  view: SessionSummary[] = [];
  cursor = 0;
  query: string;
  harness: HarnessFilter;
  project?: string;
  time: TimeFilter;
  shared: SharedFilter;
  group: GroupBy = "none";
  sort: { field: SortField; dir: "asc" | "desc" } = { field: "default", dir: "desc" };
  viewer?: SessionViewer;
  dialog?: RadioDialog;
  flow?: PublishFlow;
  private typing = false;
  private help = false;
  private quitPrompt = false;
  private message = "";
  private topLine = 0;
  private topProjects: string[];
  private now: () => number;
  private settings: SettingsStore;
  private copyText: (text: string) => void;
  private unsubscribeIndex?: () => void;

  constructor(
    private source: Source,
    opts: BrowserOptions = {},
  ) {
    super();
    this.now = opts.now ?? Date.now;
    this.settings = opts.settings ?? memorySettings();
    this.copyText = opts.copy ?? ((text) => copyToClipboard(text));
    this.query = opts.query ?? "";
    this.harness = opts.harness;
    this.topProjects = this.computeTopProjects();
    this.refilter();
    // Rows fill in while the index runs: redo the list (the selection stays on the same session) and redraw.
    this.unsubscribeIndex = source.index?.subscribe(() => {
      this.topProjects = this.computeTopProjects();
      this.refilter(this.current);
      this.dialog?.refresh();
      this.requestRender();
    });
  }

  private computeTopProjects(): string[] {
    return facet(this.source.sessions.filter((s) => !s.worker), (s) => s.project).slice(0, 14).map((f) => f.value);
  }

  /** Quitting also stops the index (which saves what it has read), whichever key asked for it. */
  override quit(): void {
    this.unsubscribeIndex?.();
    this.source.index?.stop();
    // Stop whatever is still being read or scanned in the background.
    this.viewer?.dispose();
    this.flow?.dispose();
    this.source.close();
    super.quit();
  }

  get current(): SessionSummary | undefined {
    return this.view[this.cursor];
  }

  // ── data ──
  /** Recompute the list; `keep` pins the cursor to a session that may have moved. */
  refilter(keep?: SessionSummary): void {
    const f = parseQuery(this.query, this.now());
    if (this.harness) f.harness = this.harness;
    if (this.project) f.project = this.project.toLowerCase();
    if (this.time) f.sinceMs = this.now() - TIME_MS[this.time];
    if (this.shared !== undefined) f.shared = this.shared;
    let list = searchSessions(this.source.sessions, f, this.source.shares);
    if (this.sort.field !== "default") {
      const key = SORT_KEY[this.sort.field];
      const sign = this.sort.dir === "asc" ? 1 : -1;
      list = [...list].sort((a, b) => {
        const x = key(a);
        const y = key(b);
        return (x < y ? -1 : x > y ? 1 : 0) * sign || b.mtimeMs - a.mtimeMs;
      });
    }
    if (this.group !== "none") {
      // Groups keep the sort order inside, and appear in order of first appearance.
      const groups = new Map<string, SessionSummary[]>();
      for (const s of list) {
        const label = this.groupLabel(s);
        const members = groups.get(label);
        if (members) members.push(s);
        else groups.set(label, [s]);
      }
      list = [...groups.values()].flat();
    }
    this.view = list;
    // By path: a row that was just read is a new object for the same session.
    const at = keep ? list.findIndex((s) => s.path === keep.path) : -1;
    this.cursor = at >= 0 ? at : Math.min(this.cursor, Math.max(0, list.length - 1));
  }

  /** A filter or the search changed: the old position means nothing, so start again from the first session. */
  private refilterFromTop(): void {
    this.refilter();
    this.cursor = 0;
    this.topLine = 0;
  }

  private groupLabel(s: SessionSummary): string {
    return this.group === "date" ? dayBucket(s.mtimeMs, this.now()) : this.group === "project" ? (s.project ?? "(no repo)") : HARNESS_META[s.harness].label;
  }

  /** List rows in screen order: sessions, plus a header line wherever the group changes. Cheap (no string work). */
  private entries(): Entry[] {
    const entries: Entry[] = [];
    let last: string | undefined;
    this.view.forEach((s, idx) => {
      if (this.group !== "none") {
        const g = this.groupLabel(s);
        if (g !== last) {
          entries.push({ header: g });
          last = g;
        }
      }
      entries.push({ idx });
    });
    return entries;
  }

  /** Rows the session list shows: the screen minus the 3-line header, the rule and the footer. */
  private listHeight(): number {
    return Math.max(1, this.rows - 5);
  }

  private anyFilter(): boolean {
    return !!(this.harness || this.project || this.time || this.shared !== undefined);
  }

  private clearFilters(): void {
    this.query = "";
    this.harness = this.project = this.time = this.shared = undefined;
    this.refilterFromTop();
  }

  // ── dialogs ──
  private dialogFor(kind: "harness" | "repo" | "time" | "shared" | "group" | "sort"): RadioDialog {
    // Read through `all()` on every draw: rows are still being read while the index runs, so repos, counts and workers change.
    const all = () => this.source.sessions.filter((s) => !s.worker);
    const onClose = () => {
      this.dialog = undefined;
    };
    const keep = this.current;
    const count = (p: (s: SessionSummary) => boolean) => all().filter(p).length;
    const single = (title: string | (() => string), items: () => DialogSection["items"], current: () => unknown, apply: (v: unknown) => void, searchable = false) =>
      new RadioDialog(title, [{ get items() { return items(); }, current, apply }], { searchable, onClose });
    switch (kind) {
      case "harness":
        return single(
          "Harness",
          () => [
            { label: "any", value: undefined, count: all().length },
            ...HARNESS_NAMES.map((n) => ({ label: HARNESS_META[n].label, value: n, count: count((s) => s.harness === n) })),
          ],
          () => this.harness,
          (v) => {
            this.harness = v as HarnessFilter;
            this.refilterFromTop();
          },
        );
      case "repo": {
        const repos = () => facet(all(), (s) => s.project);
        return single(
          () => `Repo (${repos().length})`,
          () => [{ label: "any", value: undefined, count: all().length }, ...repos().map((r) => ({ label: r.value, value: r.value, count: r.count }))],
          () => this.project,
          (v) => {
            this.project = v as string | undefined;
            this.refilterFromTop();
          },
          true,
        );
      }
      case "time":
        return single(
          "Updated",
          () => [{ label: "any time", value: undefined }, { label: "last 24 hours", value: "24h" }, { label: "last 7 days", value: "7d" }, { label: "last 30 days", value: "30d" }],
          () => this.time,
          (v) => {
            this.time = v as TimeFilter;
            this.refilterFromTop();
          },
        );
      case "shared":
        return single(
          "Shared",
          () => [{ label: "any", value: undefined }, { label: "not shared yet", value: false }, { label: "already shared", value: true }],
          () => this.shared,
          (v) => {
            this.shared = v as SharedFilter;
            this.refilterFromTop();
          },
        );
      case "group":
        return single(
          "Group by",
          () => GROUPS.map((g) => ({ label: g.label, value: g.id, hint: g.hint })),
          () => this.group,
          (v) => {
            this.group = v as GroupBy;
            this.refilter(keep);
          },
        );
      case "sort": {
        const field: DialogSection = {
          title: "Sort by",
          items: SORTS.map((s) => ({ label: s.label, value: s.id, hint: s.hint })),
          current: () => this.sort.field,
          apply: (v) => {
            this.setSortField(v as SortField);
            this.refilterFromTop();
          },
        };
        const dir: DialogSection = {
          title: "Direction",
          items: [
            { label: "ascending  (A → Z, small → large, old → new)", value: "asc" },
            { label: "descending (Z → A, large → small, new → old)", value: "desc" },
          ],
          current: () => this.sort.dir,
          apply: (v) => {
            this.sort.dir = v as "asc" | "desc";
            this.refilterFromTop();
          },
        };
        return new RadioDialog("Sort", [field, dir], { onClose });
      }
    }
  }

  /** `,`: preferences that persist across runs (see settings.ts). */
  private settingsDialog(): RadioDialog {
    const save = (patch: SettingsPatch) => {
      if (!this.settings.update(patch)) this.message = SAVE_FAILED_MESSAGE;
    };
    const sections: DialogSection[] = [
      {
        title: "Confirm before quitting",
        items: [{ label: "yes", value: true }, { label: "no", value: false }],
        current: () => this.settings.get().confirmQuit,
        apply: (v) => save({ confirmQuit: v as boolean }),
      },
      {
        title: "Date format (updated column)",
        items: DATE_FORMATS.map((f) => ({ label: f.label, value: f.id, hint: f.example })),
        current: () => this.settings.get().dateFormat,
        apply: (v) => save({ dateFormat: v as DateFormatId }),
      },
    ];
    return new RadioDialog("Settings", sections, {
      onClose: () => {
        this.dialog = undefined;
      },
    });
  }

  /** Choosing a sort field resets the direction to that field's natural one (A→Z for text, newest/largest first otherwise). */
  private setSortField(field: SortField): void {
    this.sort = { field, dir: SORTS.find((s) => s.id === field)!.natural };
  }

  // ── input ──
  onKey(data: string): void {
    this.message = "";
    if (this.quitPrompt) return this.quitKey(data);
    if (this.dialog) return this.dialog.onKey(data);
    if (this.flow) return this.flowKey(data);
    if (this.help) {
      this.help = false;
      return;
    }
    if (this.viewer) return this.viewer.onKey(data);
    if (this.typing) return this.typingKey(data);
    const n = this.view.length;
    let paging: PageMove | undefined;
    if (isKey(data, "q") || isKey(data, "escape")) return this.query || this.anyFilter() ? this.clearFilters() : this.requestQuit();
    if (isKey(data, "j") || isKey(data, "down")) this.cursor = Math.min(n - 1, this.cursor + 1);
    else if (isKey(data, "k") || isKey(data, "up")) this.cursor = Math.max(0, this.cursor - 1);
    else if ((paging = pagingKey(data))) this.page(paging.dir, paging.fraction);
    else if (isKey(data, "home")) this.cursor = 0;
    else if (isKey(data, "end")) this.cursor = Math.max(0, n - 1);
    else if (data === "/") this.typing = true;
    else if (data === "?") this.help = true;
    else if (data === ",") this.dialog = this.settingsDialog();
    else if (isKey(data, "ctrl+r")) this.refreshIndex();
    // one-key cycles …
    else if (isPlain(data, "h")) {
      this.harness = cycle(HARNESSES, this.harness);
      this.refilterFromTop();
    } else if (isPlain(data, "r")) {
      const repos = [undefined, ...this.topProjects];
      this.project = cycle(repos, repos.includes(this.project) ? this.project : undefined);
      this.refilterFromTop();
    } else if (isPlain(data, "t")) {
      this.time = cycle(TIMES, this.time);
      this.refilterFromTop();
    } else if (isPlain(data, "s")) {
      this.shared = cycle(SHARED, this.shared);
      this.refilterFromTop();
    } else if (isPlain(data, "g")) {
      this.group = cycle(GROUPS.map((g) => g.id), this.group);
      this.refilter(this.current);
    } else if (isPlain(data, "o")) {
      this.setSortField(cycle(SORTS.map((s) => s.id), this.sort.field));
      this.refilterFromTop();
    }
    // … and their Shift dialogs
    else if (isShift(data, "h")) this.dialog = this.dialogFor("harness");
    else if (isShift(data, "r")) this.dialog = this.dialogFor("repo");
    else if (isShift(data, "t")) this.dialog = this.dialogFor("time");
    else if (isShift(data, "s")) this.dialog = this.dialogFor("shared");
    else if (isShift(data, "g")) this.dialog = this.dialogFor("group");
    else if (isShift(data, "o")) this.dialog = this.dialogFor("sort");
    else if (isPlain(data, "x")) this.clearFilters();
    else if ((isKey(data, "enter") || isPlain(data, "p")) && this.current?.pending) this.message = "still reading this session…";
    else if (isKey(data, "enter") && this.current) this.openViewer(this.current);
    else if (isPlain(data, "p") && this.current) this.openFlow(this.current);
    else if (isPlain(data, "y") && this.current) this.copyLink(this.current);
    this.cursor = Math.max(0, Math.min(Math.max(0, this.view.length - 1), Math.floor(this.cursor)));
  }

  /** ctrl-r: pick up sessions that were written since the list was built. The selection and the filters stay (rows arrive through the index subscription). */
  private refreshIndex(): void {
    if (!this.source.index) this.message = "nothing to refresh";
    else this.source.index.refresh();
  }

  /** Quitting asks first unless the user turned that off in the settings. */
  private requestQuit(): void {
    if (this.settings.get().confirmQuit) this.quitPrompt = true;
    else this.quit();
  }

  private quitKey(data: string): void {
    if (data === "y" || data === "Y" || isKey(data, "enter") || isKey(data, "q")) {
      this.quitPrompt = false;
      this.quit();
    } else if (data === "n" || data === "N" || isKey(data, "escape")) this.quitPrompt = false;
  }

  /** Move the selection by `fraction` of the visible list, counted in screen rows so group headers take their share. */
  private page(dir: 1 | -1, fraction: number): void {
    const entries = this.entries();
    const at = entries.findIndex((e) => "idx" in e && e.idx === this.cursor);
    if (at < 0) return;
    const rows = Math.max(1, Math.floor(this.listHeight() * fraction));
    const target = Math.max(0, Math.min(entries.length - 1, at + dir * rows));
    // Headers cannot be selected: land on the nearest session in the direction of travel, else back the other way.
    for (const step of [dir, -dir]) {
      for (let i = target; i >= 0 && i < entries.length; i += step) {
        const e = entries[i]!;
        if ("idx" in e) {
          this.cursor = e.idx;
          return;
        }
      }
    }
  }

  private typingKey(data: string): void {
    if (isKey(data, "enter") || isKey(data, "down")) this.typing = false;
    else if (isKey(data, "escape")) {
      this.typing = false;
      this.query = "";
      this.refilterFromTop();
    } else if (isKey(data, "backspace")) {
      this.query = this.query.slice(0, -1);
      this.refilterFromTop();
    } else if (isKey(data, "ctrl+u")) {
      this.query = "";
      this.refilterFromTop();
    } else if (!data.startsWith("\x1b") && data >= " ") {
      this.query += data;
      this.refilterFromTop();
    }
  }

  private openViewer(s: SessionSummary): void {
    this.viewer = new SessionViewer(s, this.source, {
      settings: this.settings,
      notify: (message) => {
        this.message = message;
      },
      requestRender: () => this.requestRender(),
      openDialog: (d) => {
        this.dialog = d;
      },
      closeDialog: () => {
        this.dialog = undefined;
      },
      publish: () => this.openFlow(s),
      copy: (text) => this.copyText(text),
      close: () => {
        this.viewer?.dispose();
        this.viewer = undefined;
      },
    }, this.searchWords().join(" "));
  }

  private openFlow(s: SessionSummary): void {
    const flow: PublishFlow = new PublishFlow(
      this.source,
      s,
      () => this.requestRender(),
      () => {
        flow.dispose();
        this.flow = undefined;
        this.refilter(this.current);
        this.requestRender();
      },
    );
    this.flow = flow;
  }

  private flowKey(data: string): void {
    const f = this.flow!;
    if (isKey(data, "escape") || isKey(data, "q")) return f.back();
    if (f.step === "mode") {
      if (isKey(data, "j") || isKey(data, "down")) f.moveMode(1);
      else if (isKey(data, "k") || isKey(data, "up")) f.moveMode(-1);
      else if (data >= "1" && data <= String(SHARE_MODES.length)) f.setMode(Number(data) - 1);
      else if (isKey(data, "t")) f.cycleTarget();
      else if (isKey(data, "enter")) f.next();
    } else if (f.step === "suspicious") {
      // Not enter, for the same reason as the confirm step: continuing must be a deliberate key.
      if (data === "c" || data === "C") f.next();
      else if (data === "n" || data === "N") f.back();
    } else if (f.step === "confirm") {
      // Only an explicit y publishes: enter must not, or two quick enters (continue, continue) upload.
      if (data === "y" || data === "Y") f.next();
      else if (data === "n" || data === "N") f.back();
    } else if (f.step === "done") {
      if (isKey(data, "y") && f.url) {
        this.copyText(f.url);
        this.message = COPIED;
      } else if (isKey(data, "enter")) f.next();
    } else if (f.step === "error") {
      if (isKey(data, "enter")) f.next();
    }
  }

  private copyLink(s: SessionSummary): void {
    const last = latestShare(this.source.shares, s.harness, s.id);
    if (last) {
      this.copyText(last.link);
      // The footer is the widest place the whole link fits, to select by hand where the clipboard write did nothing.
      this.message = `${COPIED}: ${last.link}`;
    } else this.message = "not shared yet (p to publish)";
  }

  // ── drawing ──
  draw(width: number, height: number): string[] {
    const base = this.viewer ? [...this.viewer.draw(width, height - 1), this.footer(width)] : this.drawList(width, height);
    let out = base;
    if (this.quitPrompt) out = composite(base, this.drawQuit(Math.min(44, width - 4)), width);
    else if (this.flow) out = composite(base, this.drawFlow(Math.min(74, width - 4)), width);
    else if (this.dialog) out = composite(base, this.dialog.draw(Math.min(72, width - 4), height), width);
    else if (this.help) out = composite(base, this.drawHelp(Math.min(78, width - 4)), width);
    return padLines(out, height).slice(0, height);
  }

  private drawQuit(width: number): string[] {
    return box("Quit", ["Quit overshare?", "", `${st.key("y")}${st.dim("/")}${st.key("enter")} ${st.dim("quit")}   ${st.key("n")}${st.dim("/")}${st.key("esc")} ${st.dim("stay")}`, "", st.dim("turn this off with , (settings)")], width);
  }

  private footer(width: number): string {
    const k = (key: string, label: string) => `${st.key(key)} ${st.dim(label)}`;
    const keys = this.viewer
      ? this.viewer.footerKeys().map(([a, b]) => k(a, b))
      : this.typing
        ? [k("enter", "done"), k("esc", "clear")]
        : [
            k("j/k", "move"),
            k("/", "search"),
            k("h r t s", "filter"),
            ...(this.query || this.anyFilter() ? [k("x", "clear filters")] : []),
            k("g", "group"),
            k("o", "sort"),
            k("Shift+", "dialog"),
            k("enter", "open"),
            k("p", "publish"),
            k("ctrl-r", "refresh"),
            k(",", "settings"),
            k("?", "help"),
            k("q", "quit"),
          ];
    const msg = this.lastError ? `${st.red(`error: ${this.lastError}`)}  ` : this.message ? `${st.yellow(this.message)}  ` : "";
    return cut(msg + keys.join("  "), width);
  }

  private header(width: number): string[] {
    // The hotkey letter is bold + underlined inside its chip, so the chips double as a key legend.
    const chip = (name: string, hotkey: string, value: string, on: boolean) => {
      const at = name.indexOf(hotkey);
      const label = `${name.slice(0, at)}${st.hot(hotkey)}${name.slice(at + 1)}: ${value}`;
      return on ? st.chip(label) : st.chipOff(label);
    };
    const sortLabel = SORTS.find((s) => s.id === this.sort.field)!.label;
    const arrow = this.sort.dir === "asc" ? "↑" : "↓";
    const indexing = this.source.index?.progress();
    // Search and the repo/branch/model/tool filters only see sessions that have been read; say so while that is true.
    const partial = indexing && (this.query || this.project) ? " · search covers the sessions read so far" : "";
    const title = `${st.bold("overshare")}  ${st.dim(`${this.view.length}/${this.source.sessions.length}`)}${indexing ? `  ${st.yellow(`reading sessions ${indexing.done}/${indexing.total}`)}${st.dim(partial)}` : ""}`;
    const chips = [
      chip("harness", "h", this.harness ? HARNESS_META[this.harness].short : "all", !!this.harness),
      chip("repo", "r", this.project ?? "all", !!this.project),
      chip("time", "t", this.time ?? "any", !!this.time),
      chip("shared", "s", this.shared === undefined ? "any" : this.shared ? "yes" : "no", this.shared !== undefined),
      chip("group", "g", GROUPS.find((g) => g.id === this.group)!.label, this.group !== "none"),
      chip("sort", "o", `${sortLabel} ${arrow}`, this.sort.field !== "default"),
    ].join(" ");
    const search = this.typing
      ? `${st.cyan("/")} ${this.query}${st.inv(" ")}`
      : this.query
        ? `${st.cyan("/")} ${this.query}`
        : st.dim("/ search  ·  harness:pi  since:7d  shared:no  tool:Bash  model:opus");
    return [cut(title, width), cut(chips, width), cut(search, width)];
  }

  private drawList(width: number, height: number): string[] {
    const head = this.header(width);
    const bodyH = Math.max(1, height - head.length - 2);
    const lw = Math.max(30, Math.floor(width * 0.56));
    const rw = Math.max(10, width - lw - 3);
    const entries = this.entries();
    const words = this.searchWords();
    const sel = Math.max(0, entries.findIndex((e) => "idx" in e && e.idx === this.cursor));
    if (sel < this.topLine) this.topLine = "header" in (entries[sel - 1] ?? {}) ? sel - 1 : sel;
    if (sel >= this.topLine + bodyH) this.topLine = sel - bodyH + 1;
    this.topLine = Math.max(0, Math.min(this.topLine, Math.max(0, entries.length - bodyH)));
    const rows: string[] = [];
    // While typing, `x` would land in the search box, so point at the key that works there.
    if (this.view.length === 0) rows.push(st.dim(this.typing ? "  no sessions match — esc clears the search" : "  no sessions match — x clears filters"));
    for (const e of entries.slice(this.topLine, this.topLine + bodyH)) {
      rows.push("header" in e ? st.dim(`── ${e.header} ${"─".repeat(Math.max(0, lw - w(e.header) - 4))}`) : this.row(this.view[e.idx]!, e.idx === this.cursor, lw, words));
    }
    const preview = this.current ? this.preview(this.current, rw, words) : [];
    return [...head, ...columns(padLines(rows, bodyH), padLines(preview.slice(0, bodyH), bodyH), lw, rw), hr(width), this.footer(width)];
  }

  /** The free words of the search: what the rows and the preview highlight. */
  private searchWords(): string[] {
    return this.query ? parseQuery(this.query, this.now()).words : [];
  }

  private row(s: SessionSummary, selected: boolean, width: number, words: readonly string[]): string {
    const mark = (text: string) => markLine(text, words).line;
    const shared = sharesFor(this.source.shares, s.harness, s.id).length > 0;
    const harness = st[HARNESS_META[s.harness].color](HARNESS_META[s.harness].tag.padEnd(2));
    const fmt = dateFormat(this.settings.get().dateFormat);
    const fixed = 1 + (fmt.width + 1) + 3 + 15 + 3;
    // The branch column only appears when the title keeps a useful width without it.
    const branchW = width - fixed - BRANCH_COL - 1 >= MIN_TITLE ? BRANCH_COL : 0;
    const project = s.pending ? "…" : (s.project ?? "?");
    const title = s.pending ? st.dim("reading…") : (s.title ?? "(untitled)");
    // A guessed branch (from the repo's reflog, not the transcript) is marked with ~.
    const branch = branchW ? `${mark(fit(s.branch ? st.dim(`${s.branchGuess ? "~" : ""}${s.branch}`) : "", branchW))} ` : "";
    const cells = `${selected ? st.cyan("▌") : " "}${fit(fmt.format(s.mtimeMs, this.now()), fmt.width + 1)}${harness} ${mark(fit(st.dim(project), 14))} ${branch}${mark(fit(title, width - fixed - (branchW ? branchW + 1 : 0)))} ${shared ? st.green("✓") : " "}`;
    return selected ? st.sel(fit(cells, width)) : cells;
  }

  /**
   * Where the search's words are, for the words the list row and the header do not already show: a short stretch of the
   * prompt each is in. The prompts kept in their own case come first; text only the search index has is lower-cased.
   */
  private matchSnippets(s: SessionSummary, words: readonly string[], width: number): string[] {
    const shown = [s.title, s.project, s.branch, s.models.join(" ")].join("\n").toLowerCase();
    // A word of one letter cannot be found in text (see MIN_HIGHLIGHT), so there is nothing to quote for it.
    let need = words.filter((word) => word.length >= MIN_HIGHLIGHT && !shown.includes(word));
    const own = [...new Set([s.firstPrompt, ...s.promptHead, ...s.promptTail, s.lastPrompt].filter((t): t is string => !!t))];
    const out: string[] = [];
    for (const pool of [own, s.searchText.split("\n")]) {
      while (need.length && out.length < MAX_SNIPPETS) {
        // The prompt holding the most of the words still unexplained.
        let best: string | undefined;
        let most = 0;
        for (const text of pool) {
          const lower = text.toLowerCase();
          const n = need.filter((word) => lower.includes(word)).length;
          if (n > most) [best, most] = [text, n];
        }
        if (!best) break;
        // The snippet is a stretch around the first word it holds: a word elsewhere in the prompt is not explained until
        // a snippet shows it, so only the words that are in the lines shown count as done (the next round takes the rest).
        const line = snippet(best, need, width - 2);
        if (!line) break;
        out.push(line);
        const lower = line.toLowerCase();
        need = need.filter((word) => !lower.includes(word));
      }
    }
    return out;
  }

  private preview(s: SessionSummary, width: number, words: readonly string[] = []): string[] {
    if (s.pending) return [st.dim(HARNESS_META[s.harness].label), st.dim(formatBytes(s.size)), "", st.dim("reading this session…")];
    const mark = (line: string) => markLine(line, words).line;
    const out: string[] = [];
    out.push(...wrap(st.bold(s.title ?? "(untitled)"), width).slice(0, 2).map(mark));
    out.push(mark(st.dim([HARNESS_META[s.harness].label, s.models.map(shortModel).join(", "), branchLabel(s), sessionDuration(s)].filter(Boolean).join(" · "))));
    out.push(st.dim(`${plural(s.prompts, "prompt")} · ${plural(s.calls, "model call")} · ${formatBytes(s.size)}${s.subagents ? ` · ${plural(s.subagents, "subagent")}` : ""}`));
    const tools = toolSummary(s.tools);
    if (tools) out.push(st.dim(tools));
    const last = latestShare(this.source.shares, s.harness, s.id);
    if (last) {
      out.push(st.green(`✓ shared ${ago(Date.parse(last.record.sharedAt), this.now())} (${last.record.mode})`) + (last.earlier ? st.dim(` · +${last.earlier} earlier`) : ""));
      out.push(st.cyan(elide(last.link, width)));
    }
    const found = words.length ? this.matchSnippets(s, words, width) : [];
    if (found.length) out.push("", st.cyan("matched in prompts"), ...found.map((l) => mark(`${st.dim("· ")}${cut(l, width - 2)}`)));
    out.push("", st.cyan("first prompt"), ...wrap(s.firstPrompt ?? "", width).slice(0, 4).map((l) => mark(st.dim(l))));
    if (s.lastPrompt && s.lastPrompt !== s.firstPrompt) out.push("", st.cyan("latest prompt"), ...wrap(s.lastPrompt, width).slice(0, 3).map((l) => mark(st.dim(l))));
    if (s.lastReply) out.push("", st.cyan("last reply"), ...wrap(s.lastReply, width).slice(0, 5).map((l) => mark(st.dim(l))));
    if (s.promptHead.length > 2) {
      out.push("", st.cyan(`prompts (${s.prompts})`));
      s.promptHead.slice(0, 6).forEach((p, i) => out.push(`${st.dim(`${i + 1}.`)} ${mark(cut(p, width - 3))}`));
      if (s.prompts > 6) out.push(st.dim(`   … ${s.prompts - 6} more`));
    }
    return out;
  }

  private drawFlow(width: number): string[] {
    const f = this.flow!;
    const inner: string[] = [st.dim(cut(f.session.title ?? "", width - 4)), ""];
    if (f.step === "suspicious") {
      const r = f.review!;
      inner.push(st.yellow(st.bold(`${plural(r.suspicious.length, "suspicious value")} could not be redacted`)), ...wrap(st.dim("They look like they could be secrets, are still in the payload and would be published as they are."), width - 6), "");
      for (const i of r.suspicious.slice(0, 8)) inner.push(...wrap(`${st.yellow("?")} ${i.rule} ${st.dim(`(${plural(i.length, "char")}${i.occurrences > 1 ? `, ×${i.occurrences}` : ""}) @ ${i.location}${i.lines ? ` · ${i.lines}` : ""}`)}`, width - 6));
      if (r.suspicious.length > 8) inner.push(st.dim(`  … ${r.suspicious.length - 8} more`));
      inner.push(
        "",
        ...wrap(`Look at these places in ${st.cyan(stripControls(f.session.path))} (turn numbers as in this viewer, line numbers of that file), and publish only if they are fine.`, width - 6),
        ...wrap(st.dim("Add a value that is fine to redact.allowlist to stop being asked. Secrets with no recognizable format are not detected at all."), width - 6),
        "",
        `${st.key("c")} ${st.dim("continue anyway")}  ${st.key("n")} ${st.dim("back")}  ${st.key("esc")} ${st.dim("cancel")}`,
      );
    } else if (f.step === "mode" || f.step === "confirm") {
      // Where this publish goes: the configured default unless switched with `t`, and a target that cannot publish says so here.
      const targets = SHARE_TARGETS.map((t) => {
        const label = f.preflightOf(t).error ? `${t} ✗` : t;
        return t === f.target ? `${st.cyan("›")} ${st.bold(label)}` : `  ${st.dim(label)}`;
      });
      inner.push(`${st.dim("to")}  ${targets.join(" ")}`, st.dim(`${destinationLabel(f.target)} · ${f.target === this.source.target ? "your default" : "this publish only"}`), "");
      SHARE_MODES.forEach((m, i) => {
        const on = i === f.modeIdx;
        inner.push(`${on ? st.cyan("›") : " "} ${st.dim(`${i + 1}`)} ${on ? st.bold(m.padEnd(8)) : m.padEnd(8)} ${st.dim(MODE_HINT[m])}`);
      });
      inner.push("");
      const r = f.review;
      if (f.preflight.error) inner.push(st.red("✗ cannot publish:"), ...wrap(st.dim(f.preflight.error), width - 6).slice(0, 4));
      else if (f.refusal) {
        inner.push(st.red(`✗ ${f.mode} mode is not available for this session:`), ...wrap(st.dim(f.refusal.replace(/^Cannot use \w+ mode: /, "")), width - 6).slice(0, 5), st.dim("pick another mode"));
      } else if (f.loading || !r) inner.push(st.dim(`${f.spinnerFrame} scanning for secrets…`));
      else {
        inner.push(`${formatBytes(r.bytes)} payload · ${plural(r.redactions, "redaction")}`);
        if (r.blocked) {
          inner.push(st.red("✗ blocked: unredacted secrets remain"));
          for (const i of r.issues.slice(0, 4)) inner.push(...wrap(st.dim(`  ${i.rule}${i.length === undefined ? "" : ` (${plural(i.length, "char")})`}${i.location ? ` @ ${i.location}` : ""}${i.lines ? ` · ${i.lines}` : ""}`), width - 6));
          if (r.issues.length > 4) inner.push(st.dim(`  … ${r.issues.length - 4} more`));
          if (r.issues.some((i) => i.lines)) inner.push(...wrap(st.dim(`line numbers are of ${stripControls(f.session.path)}`), width - 6));
        }
        else if (r.clean) inner.push(st.green("✓ clean"));
        else if (r.findings.length) inner.push(st.yellow(`! ${plural(r.findings.length, "finding")} — redacted, please review`));
        for (const x of r.findings.slice(0, 3)) inner.push(st.dim(`  ${x.rule} @ ${x.where}`));
        if (r.suspicious.length) inner.push(...wrap(st.yellow(`? ${plural(r.suspicious.length, "suspicious value")} left in the payload — you will be asked to look at ${r.suspicious.length === 1 ? "it" : "them"} first`), width - 6));
        // Not capped: the "not read" half sits at the end and is the part a narrow terminal would otherwise cut.
        inner.push(...wrap(st.dim(`known values: ${formatKnownSources(r.knownSources)}`), width - 6));
      }
      for (const warning of f.preflight.warnings) inner.push(...wrap(st.yellow(`warning: ${warning}`), width - 6));
      if (f.alreadyShared) inner.push(st.yellow("this session was already shared once"));
      inner.push("");
      inner.push(
        f.step === "mode"
          ? `${st.key("enter")} ${st.dim("continue")}  ${st.key("j/k")} ${st.dim("mode")}  ${st.key("t")} ${st.dim("target")}  ${st.key("esc")} ${st.dim("cancel")}`
          : `${st.bold(`Publish ${f.mode} to ${destinationLabel(f.target)}?`)} ${st.key("y")}/${st.key("n")}`,
      );
    } else if (f.step === "busy") inner.push(st.dim("publishing…"));
    else if (f.step === "error") inner.push(st.red("✗ publishing failed:"), ...wrap(f.failure ?? "unknown error", width - 6).slice(0, 6), "", `${st.key("enter")} ${st.dim("back")}  ${st.key("esc")} ${st.dim("close")}`);
    else {
      inner.push(st.green("✓ published"), st.cyan(f.url ?? ""));
      for (const warning of f.warnings) inner.push(...wrap(st.yellow(`warning: ${warning}`), width - 6));
      inner.push("", `${st.key("y")} ${st.dim("copy link")}  ${st.key("enter")} ${st.dim("close")}`);
    }
    return box("Publish", inner, width);
  }

  private drawHelp(width: number): string[] {
    const row = (k: string, d: string) => `${st.key(k.padEnd(12))} ${d}`;
    return box(
      "Keys",
      [
        st.bold("List"),
        row("j/k  ↑/↓", "move · home/end"),
        row("space  b", "page down · up (also PgDn PgUp, ctrl-f ctrl-b)"),
        row("ctrl-d/u", "half a page down · up"),
        row("/", "search (harness:pi since:7d tool:Bash shared:no …); the words are highlighted"),
        row("h r t s", "cycle harness · repo · time · shared"),
        row("g  o", "cycle grouping · sort field"),
        st.dim("  changing a filter, the search or the sort selects the first session again"),
        row("H R T S G O", "Shift: pick from a dialog (R: / filters the repo list; O: field + direction)"),
        row("x", "clear search + filters"),
        row("ctrl-r", "refresh: read sessions written since launch (selection and filters stay)"),
        row(",", "settings: confirm before quitting · date format"),
        row("enter  p  y", "open viewer · publish · copy link"),
        row("t", "in the publish dialog: switch the target (gist · R2) for this publish"),
        "",
        st.bold("Viewer"),
        row("j/k  J/K", "message (or scroll, in the content pane) · previous/next prompt"),
        row("enter  tab", "read the message: focus the content pane (l / → too)"),
        row("esc  tab", "back to the list from the content pane (h / ← / q too)"),
        row("space  b", "page down / up in whichever pane has the focus; g/G top/bottom"),
        row("y", "copy the selected message to the clipboard"),
        row("v  V", "cycle prompts → conversation → everything · dialog + layout"),
        row("/  n  N", "search the messages (all words in one) · next · previous hit"),
        row("o  x", "include tool output in the search · clear the search"),
        "",
        st.dim("any key closes this"),
      ],
      width,
    );
  }
}
