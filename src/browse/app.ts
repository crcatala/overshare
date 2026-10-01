/**
 * The session browser: list + always-on preview, one-key filter cycles with Shift+key radio dialogs,
 * grouping and sorting, a two-pane session viewer, and a publish dialog.
 *
 *   list      h harness · r repo · t time · s shared · g group · o sort   (x clears filters)
 *             Shift+key opens the same choice as a dialog: H R T S G O     (R: type / to filter the repo list)
 *   search    /  free words plus harness:pi project:x branch:y model:opus tool:Bash since:7d shared:no workers:yes
 *   open      enter → viewer (message list ↔ content); v cycles prompts / conversation / everything
 *   publish   p → mode → review → confirm; yes uploads exactly what was reviewed
 */
import { formatBytes } from "../format.js";
import { SHARE_MODES, type HarnessName } from "../schema.js";
import { facet, parseQuery, searchSessions } from "../sessions/query.js";
import { sharesFor } from "../sessions/shares.js";
import type { SessionSummary } from "../sessions/summary.js";
import { ago, dayBucket, durationMs, plural, sessionDuration, shortModel, toolSummary } from "./display.js";
import { RadioDialog, type DialogSection } from "./dialogs.js";
import { copyToClipboard, MODE_HINT, PublishFlow } from "./flow.js";
import { box, columns, composite, cut, fit, hr, isKey, isPlain, isShift, padLines, Screen, st, w, wrap } from "./kit.js";
import type { Source } from "./source.js";
import { SessionViewer } from "./viewer.js";

type HarnessFilter = HarnessName | undefined;
type TimeFilter = "24h" | "7d" | "30d" | undefined;
type SharedFilter = boolean | undefined;
export type GroupBy = "none" | "date" | "project" | "harness";
export type SortField = "default" | "updated" | "title" | "project" | "size" | "prompts" | "calls" | "duration";

const TIME_MS = { "24h": 86_400_000, "7d": 604_800_000, "30d": 2_592_000_000 } as const;
const HARNESSES: HarnessFilter[] = [undefined, "claude-code", "pi"];
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

const cycle = <T>(list: T[], current: T): T => list[(list.indexOf(current) + 1) % list.length]!;

type Entry = { header: string } | { idx: number };

export interface BrowserOptions {
  /** Initial search text. */
  query?: string;
  harness?: HarnessName;
  /** Clock, injectable for tests. */
  now?: () => number;
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
  private message = "";
  private topLine = 0;
  private topProjects: string[];
  private now: () => number;

  constructor(
    private source: Source,
    opts: BrowserOptions = {},
  ) {
    super();
    this.now = opts.now ?? Date.now;
    this.query = opts.query ?? "";
    this.harness = opts.harness;
    this.topProjects = facet(source.sessions.filter((s) => !s.worker), (s) => s.project).slice(0, 14).map((f) => f.value);
    this.refilter();
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
    const at = keep ? list.indexOf(keep) : -1;
    this.cursor = at >= 0 ? at : Math.min(this.cursor, Math.max(0, list.length - 1));
  }

  private groupLabel(s: SessionSummary): string {
    return this.group === "date" ? dayBucket(s.mtimeMs, this.now()) : this.group === "project" ? (s.project ?? "(no repo)") : s.harness === "pi" ? "pi" : "Claude Code";
  }

  private anyFilter(): boolean {
    return !!(this.harness || this.project || this.time || this.shared !== undefined);
  }

  private clearFilters(): void {
    this.query = "";
    this.harness = this.project = this.time = this.shared = undefined;
    this.refilter();
  }

  // ── dialogs ──
  private dialogFor(kind: "harness" | "repo" | "time" | "shared" | "group" | "sort"): RadioDialog {
    const all = this.source.sessions.filter((s) => !s.worker);
    const onClose = () => {
      this.dialog = undefined;
    };
    const keep = this.current;
    const count = (p: (s: SessionSummary) => boolean) => all.filter(p).length;
    const single = (title: string, items: DialogSection["items"], current: () => unknown, apply: (v: unknown) => void, searchable = false) =>
      new RadioDialog(title, [{ items, current, apply }], { searchable, onClose });
    switch (kind) {
      case "harness":
        return single(
          "Harness",
          [
            { label: "any", value: undefined, count: all.length },
            { label: "Claude Code", value: "claude-code", count: count((s) => s.harness === "claude-code") },
            { label: "pi", value: "pi", count: count((s) => s.harness === "pi") },
          ],
          () => this.harness,
          (v) => {
            this.harness = v as HarnessFilter;
            this.refilter(keep);
          },
        );
      case "repo": {
        const repos = facet(all, (s) => s.project);
        return single(
          `Repo (${repos.length})`,
          [{ label: "any", value: undefined, count: all.length }, ...repos.map((r) => ({ label: r.value, value: r.value, count: r.count }))],
          () => this.project,
          (v) => {
            this.project = v as string | undefined;
            this.refilter(keep);
          },
          true,
        );
      }
      case "time":
        return single(
          "Updated",
          [{ label: "any time", value: undefined }, { label: "last 24 hours", value: "24h" }, { label: "last 7 days", value: "7d" }, { label: "last 30 days", value: "30d" }],
          () => this.time,
          (v) => {
            this.time = v as TimeFilter;
            this.refilter(keep);
          },
        );
      case "shared":
        return single(
          "Shared",
          [{ label: "any", value: undefined }, { label: "not shared yet", value: false }, { label: "already shared", value: true }],
          () => this.shared,
          (v) => {
            this.shared = v as SharedFilter;
            this.refilter(keep);
          },
        );
      case "group":
        return single(
          "Group by",
          GROUPS.map((g) => ({ label: g.label, value: g.id, hint: g.hint })),
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
            this.refilter(keep);
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
            this.refilter(keep);
          },
        };
        return new RadioDialog("Sort", [field, dir], { onClose });
      }
    }
  }

  /** Choosing a sort field resets the direction to that field's natural one (A→Z for text, newest/largest first otherwise). */
  private setSortField(field: SortField): void {
    this.sort = { field, dir: SORTS.find((s) => s.id === field)!.natural };
  }

  // ── input ──
  onKey(data: string): void {
    this.message = "";
    if (this.dialog) return this.dialog.onKey(data);
    if (this.flow) return this.flowKey(data);
    if (this.help) {
      this.help = false;
      return;
    }
    if (this.viewer) return this.viewer.onKey(data);
    if (this.typing) return this.typingKey(data);
    const n = this.view.length;
    const page = Math.max(1, this.rows - 6);
    if (isKey(data, "q") || isKey(data, "escape")) return this.query || this.anyFilter() ? this.clearFilters() : this.quit();
    if (isKey(data, "j") || isKey(data, "down")) this.cursor = Math.min(n - 1, this.cursor + 1);
    else if (isKey(data, "k") || isKey(data, "up")) this.cursor = Math.max(0, this.cursor - 1);
    else if (isKey(data, "ctrl+d") || isKey(data, "pageDown")) this.cursor = Math.min(n - 1, this.cursor + Math.floor(page / 2));
    else if (isKey(data, "ctrl+u") || isKey(data, "pageUp")) this.cursor = Math.max(0, this.cursor - Math.floor(page / 2));
    else if (isKey(data, "home")) this.cursor = 0;
    else if (isKey(data, "end")) this.cursor = Math.max(0, n - 1);
    else if (data === "/") this.typing = true;
    else if (data === "?") this.help = true;
    // one-key cycles …
    else if (isPlain(data, "h")) {
      this.harness = cycle(HARNESSES, this.harness);
      this.refilter(this.current);
    } else if (isPlain(data, "r")) {
      const repos = [undefined, ...this.topProjects];
      this.project = cycle(repos, repos.includes(this.project) ? this.project : undefined);
      this.refilter();
    } else if (isPlain(data, "t")) {
      this.time = cycle(TIMES, this.time);
      this.refilter();
    } else if (isPlain(data, "s")) {
      this.shared = cycle(SHARED, this.shared);
      this.refilter();
    } else if (isPlain(data, "g")) {
      this.group = cycle(GROUPS.map((g) => g.id), this.group);
      this.refilter(this.current);
    } else if (isPlain(data, "o")) {
      this.setSortField(cycle(SORTS.map((s) => s.id), this.sort.field));
      this.refilter(this.current);
    }
    // … and their Shift dialogs
    else if (isShift(data, "h")) this.dialog = this.dialogFor("harness");
    else if (isShift(data, "r")) this.dialog = this.dialogFor("repo");
    else if (isShift(data, "t")) this.dialog = this.dialogFor("time");
    else if (isShift(data, "s")) this.dialog = this.dialogFor("shared");
    else if (isShift(data, "g")) this.dialog = this.dialogFor("group");
    else if (isShift(data, "o")) this.dialog = this.dialogFor("sort");
    else if (isPlain(data, "x")) this.clearFilters();
    else if (isKey(data, "enter") && this.current) this.openViewer(this.current);
    else if (isPlain(data, "p") && this.current) this.openFlow(this.current);
    else if (isPlain(data, "y") && this.current) this.copyLink(this.current);
    this.cursor = Math.max(0, Math.min(Math.max(0, this.view.length - 1), Math.floor(this.cursor)));
  }

  private typingKey(data: string): void {
    if (isKey(data, "enter") || isKey(data, "down")) this.typing = false;
    else if (isKey(data, "escape")) {
      this.typing = false;
      this.query = "";
      this.refilter();
    } else if (isKey(data, "backspace")) {
      this.query = this.query.slice(0, -1);
      this.refilter();
    } else if (isKey(data, "ctrl+u")) {
      this.query = "";
      this.refilter();
    } else if (!data.startsWith("\x1b") && data >= " ") {
      this.query += data;
      this.refilter();
    }
  }

  private openViewer(s: SessionSummary): void {
    this.viewer = new SessionViewer(s, this.source, {
      requestRender: () => this.requestRender(),
      openDialog: (d) => {
        this.dialog = d;
      },
      closeDialog: () => {
        this.dialog = undefined;
      },
      publish: () => this.openFlow(s),
      close: () => {
        this.viewer?.dispose();
        this.viewer = undefined;
      },
    });
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
      else if (isKey(data, "enter")) f.next();
    } else if (f.step === "confirm") {
      // Only an explicit y publishes: enter must not, or two quick enters (continue, continue) upload.
      if (data === "y" || data === "Y") f.next();
      else if (data === "n" || data === "N") f.back();
    } else if (f.step === "done") {
      if (isKey(data, "y") && f.url) {
        copyToClipboard(f.url);
        this.message = "link copied";
      } else if (isKey(data, "enter")) f.next();
    } else if (f.step === "error") {
      if (isKey(data, "enter")) f.next();
    }
  }

  private copyLink(s: SessionSummary): void {
    const link = sharesFor(this.source.shares, s.harness, s.id).at(-1)?.url;
    if (link) {
      copyToClipboard(link);
      this.message = "link copied";
    } else this.message = "not shared yet (p to publish)";
  }

  // ── drawing ──
  draw(width: number, height: number): string[] {
    const base = this.viewer ? [...this.viewer.draw(width, height - 1), this.footer(width)] : this.drawList(width, height);
    let out = base;
    if (this.flow) out = composite(base, this.drawFlow(Math.min(74, width - 4)), width);
    else if (this.dialog) out = composite(base, this.dialog.draw(Math.min(64, width - 4), height), width);
    else if (this.help) out = composite(base, this.drawHelp(Math.min(78, width - 4)), width);
    return padLines(out, height).slice(0, height);
  }

  private footer(width: number): string {
    const k = (key: string, label: string) => `${st.key(key)} ${st.dim(label)}`;
    const keys = this.viewer
      ? this.viewer.footerKeys().map(([a, b]) => k(a, b))
      : this.typing
        ? [k("enter", "done"), k("esc", "clear")]
        : [k("j/k", "move"), k("/", "search"), k("h r t s", "filter"), k("g", "group"), k("o", "sort"), k("Shift+", "dialog"), k("enter", "open"), k("p", "publish"), k("?", "help"), k("q", "quit")];
    const msg = this.lastError ? `${st.red(`error: ${this.lastError}`)}  ` : this.message ? `${st.yellow(this.message)}  ` : "";
    return cut(msg + keys.join("  "), width);
  }

  private header(width: number): string[] {
    const chip = (label: string, on: boolean) => (on ? st.chip(label) : st.chipOff(label));
    const sortLabel = SORTS.find((s) => s.id === this.sort.field)!.label;
    const arrow = this.sort.dir === "asc" ? "↑" : "↓";
    const title = `${st.bold("agent-share")}  ${st.dim(`${this.view.length}/${this.source.sessions.length}`)}`;
    const chips = [
      chip(`harness: ${this.harness ? (this.harness === "pi" ? "pi" : "claude") : "all"}`, !!this.harness),
      chip(`repo: ${this.project ?? "all"}`, !!this.project),
      chip(`time: ${this.time ?? "any"}`, !!this.time),
      chip(`shared: ${this.shared === undefined ? "any" : this.shared ? "yes" : "no"}`, this.shared !== undefined),
      chip(`group: ${GROUPS.find((g) => g.id === this.group)!.label}`, this.group !== "none"),
      chip(`sort: ${sortLabel} ${arrow}`, this.sort.field !== "default"),
    ].join(" ");
    const search = this.typing
      ? `${st.cyan("/")} ${this.query}${st.inv(" ")}`
      : this.query
        ? `${st.cyan("/")} ${this.query}`
        : st.dim("/ search  ·  harness:pi  since:7d  shared:no  tool:Bash  model:opus");
    return [title, cut(chips, width), cut(search, width)];
  }

  private drawList(width: number, height: number): string[] {
    const head = this.header(width);
    const bodyH = Math.max(1, height - head.length - 2);
    const lw = Math.max(30, Math.floor(width * 0.56));
    const rw = Math.max(10, width - lw - 3);
    // Entries are cheap (no string work); only the visible window is formatted.
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
    const sel = Math.max(0, entries.findIndex((e) => "idx" in e && e.idx === this.cursor));
    if (sel < this.topLine) this.topLine = "header" in (entries[sel - 1] ?? {}) ? sel - 1 : sel;
    if (sel >= this.topLine + bodyH) this.topLine = sel - bodyH + 1;
    this.topLine = Math.max(0, Math.min(this.topLine, Math.max(0, entries.length - bodyH)));
    const rows: string[] = [];
    if (this.view.length === 0) rows.push(st.dim("  no sessions match — x clears filters"));
    for (const e of entries.slice(this.topLine, this.topLine + bodyH)) {
      rows.push("header" in e ? st.dim(`── ${e.header} ${"─".repeat(Math.max(0, lw - w(e.header) - 4))}`) : this.row(this.view[e.idx]!, e.idx === this.cursor, lw));
    }
    const preview = this.current ? this.preview(this.current, rw) : [];
    return [...head, ...columns(padLines(rows, bodyH), padLines(preview, bodyH), lw, rw), hr(width), this.footer(width)];
  }

  private row(s: SessionSummary, selected: boolean, width: number): string {
    const shared = sharesFor(this.source.shares, s.harness, s.id).length > 0;
    const harness = s.harness === "pi" ? st.magenta("π ") : st.yellow("CC");
    const fixed = 1 + 11 + 3 + 15 + 3;
    const cells = `${selected ? st.cyan("▌") : " "}${fit(ago(s.mtimeMs, this.now()), 11)}${harness} ${fit(st.dim(s.project ?? "?"), 14)} ${fit(s.title ?? "(untitled)", width - fixed)} ${shared ? st.green("✓") : " "}`;
    return selected ? st.sel(fit(cells, width)) : cells;
  }

  private preview(s: SessionSummary, width: number): string[] {
    const out: string[] = [];
    out.push(...wrap(st.bold(s.title ?? "(untitled)"), width).slice(0, 2));
    out.push(st.dim([s.harness === "pi" ? "pi" : "Claude Code", s.models.map(shortModel).join(", "), s.branch, sessionDuration(s)].filter(Boolean).join(" · ")));
    out.push(st.dim(`${plural(s.prompts, "prompt")} · ${plural(s.calls, "model call")} · ${formatBytes(s.size)}${s.subagents ? ` · ${plural(s.subagents, "subagent")}` : ""}`));
    const tools = toolSummary(s.tools);
    if (tools) out.push(st.dim(tools));
    const last = sharesFor(this.source.shares, s.harness, s.id).at(-1);
    if (last) out.push(st.green(`✓ shared ${ago(Date.parse(last.sharedAt), this.now())} (${last.mode})`));
    out.push("", st.cyan("first prompt"), ...wrap(s.firstPrompt ?? "", width).slice(0, 4).map((l) => st.dim(l)));
    if (s.lastPrompt && s.lastPrompt !== s.firstPrompt) out.push("", st.cyan("latest prompt"), ...wrap(s.lastPrompt, width).slice(0, 3).map((l) => st.dim(l)));
    if (s.promptHead.length > 2) {
      out.push("", st.cyan(`prompts (${s.prompts})`));
      s.promptHead.slice(0, 6).forEach((p, i) => out.push(`${st.dim(`${i + 1}.`)} ${cut(p, width - 3)}`));
      if (s.prompts > 6) out.push(st.dim(`   … ${s.prompts - 6} more`));
    }
    return out;
  }

  private drawFlow(width: number): string[] {
    const f = this.flow!;
    const inner: string[] = [st.dim(cut(f.session.title ?? "", width - 4)), ""];
    if (f.step === "mode" || f.step === "confirm") {
      SHARE_MODES.forEach((m, i) => {
        const on = i === f.modeIdx;
        inner.push(`${on ? st.cyan("›") : " "} ${st.dim(`${i + 1}`)} ${on ? st.bold(m.padEnd(8)) : m.padEnd(8)} ${st.dim(MODE_HINT[m])}`);
      });
      inner.push("");
      const r = f.review;
      if (f.preflight.error) inner.push(st.red("✗ cannot publish:"), ...wrap(st.dim(f.preflight.error), width - 6).slice(0, 4));
      else if (f.refusal) {
        inner.push(st.red(`✗ ${f.mode} mode is not available for this session:`), ...wrap(st.dim(f.refusal.replace(/^Cannot use \w+ mode: /, "")), width - 6).slice(0, 5), st.dim("pick another mode"));
      } else if (f.loading || !r) inner.push(st.dim("scanning for secrets…"));
      else {
        inner.push(`${formatBytes(r.bytes)} payload · ${plural(r.redactions, "redaction")}`);
        inner.push(r.blocked ? st.red("✗ blocked: unredacted secrets remain") : r.clean ? st.green("✓ clean") : st.yellow(`! ${plural(r.findings.length, "finding")} — redacted, please review`));
        for (const x of r.findings.slice(0, 3)) inner.push(st.dim(`  ${x.rule} @ ${x.where}`));
      }
      for (const warning of f.preflight.warnings) inner.push(...wrap(st.yellow(`warning: ${warning}`), width - 6).slice(0, 3));
      if (f.alreadyShared) inner.push(st.yellow("this session was already shared once"));
      inner.push("");
      inner.push(
        f.step === "mode"
          ? `${st.key("enter")} ${st.dim("continue")}  ${st.key("j/k")} ${st.dim("mode")}  ${st.key("esc")} ${st.dim("cancel")}`
          : `${st.bold(`Publish ${f.mode} to ${this.source.destination}?`)} ${st.key("y")}/${st.key("n")}`,
      );
    } else if (f.step === "busy") inner.push(st.dim("publishing…"));
    else if (f.step === "error") inner.push(st.red("✗ publishing failed:"), ...wrap(f.failure ?? "unknown error", width - 6).slice(0, 6), "", `${st.key("enter")} ${st.dim("back")}  ${st.key("esc")} ${st.dim("close")}`);
    else {
      inner.push(st.green("✓ published"), st.cyan(f.url ?? ""));
      for (const warning of f.warnings) inner.push(...wrap(st.yellow(`warning: ${warning}`), width - 6).slice(0, 3));
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
        row("j/k  ↑/↓", "move · ctrl-d/u page · home/end"),
        row("/", "search (harness:pi since:7d tool:Bash shared:no …)"),
        row("h r t s", "cycle harness · repo · time · shared"),
        row("g  o", "cycle grouping · sort field"),
        row("H R T S G O", "Shift: pick from a dialog (R: / filters the repo list; O: field + direction)"),
        row("x", "clear search + filters"),
        row("enter  p  y", "open viewer · publish · copy link"),
        "",
        st.bold("Viewer"),
        row("j/k  J/K", "message · previous/next prompt"),
        row("v  V", "cycle prompts → conversation → everything · dialog"),
        row("space", "scroll the content pane"),
        "",
        st.dim("any key closes this"),
      ],
      width,
    );
  }
}
