/**
 * Radio-list dialog: one or more titled sections of single-choice items. Backs the Shift+key dialogs
 * (repo, harness, time, shared, group, sort, message list).
 *
 *   ↑/↓ j/k  move        enter  choose + close        space  choose, stay open (handy for sort)
 *   /        filter the list (searchable dialogs)     esc    close (or leave the filter first)
 *   PgUp/PgDn ctrl-b/f  a window up/down   ctrl-u/d  half a window
 *
 * The box never grows with its list: a long list shows a fixed window of `WINDOW` rows that follows the cursor, with a
 * row of dots under it for where you are (like pi-skill-palette's), and the box is as wide for the whole list as for the
 * part that matches the filter, so typing never makes it jump.
 */
import { box, cut, isKey, st, typedText, w } from "./kit.js";

/** Rows of the list a dialog shows at most (sections' titles count as rows). */
export const WINDOW = 10;
/** The narrowest a dialog gets, so a short list ("any · pi · Claude Code") does not make a sliver. */
const MIN_WIDTH = 44;
/** Dots in the position meter. */
const METER = 10;
/** Filled to empty: blue through cyan to green. */
const METER_COLORS = [33, 33, 39, 38, 44, 43, 42, 41, 41, 40];

/** `● ● ● ○ ○ …`: where the cursor is in the list, in tenths. */
export function meter(at: number, total: number): string {
  const filled = total <= 1 ? METER : Math.max(1, Math.round(((at + 1) / total) * METER));
  return Array.from({ length: METER }, (_, i) => (i < filled ? `\x1b[38;5;${METER_COLORS[i]}m●\x1b[39m` : st.gray("○"))).join(" ");
}

export interface DialogItem {
  label: string;
  value: unknown;
  count?: number;
  hint?: string;
}

export interface DialogSection {
  title?: string;
  /** Read on every draw and key, so a section may be a getter over data that changes while the dialog is open. */
  items: DialogItem[];
  /** Read on every draw so the dot follows the live state. */
  current: () => unknown;
  apply: (value: unknown) => void;
}

type ItemLine = { kind: "item"; section: DialogSection; item: DialogItem };
type Line = { kind: "title"; text: string } | ItemLine;

export class RadioDialog {
  private cursor = 0;
  private filter = "";
  private filtering = false;
  /** Rows the window showed on the last draw: the size of a page. */
  private window = WINDOW;
  /** The item under the cursor, so `refresh` can put the cursor back on it when the items change. */
  private on?: { section: DialogSection; value: unknown };

  constructor(
    private readonly heading: string | (() => string),
    readonly sections: DialogSection[],
    readonly opts: { searchable?: boolean; /** Rows to show before scrolling, in place of `WINDOW`. */ window?: number; onClose: () => void },
  ) {
    // Start on the currently chosen item of the first section.
    const first = sections[0];
    const i = first ? this.selectable().findIndex((l) => l.section === first && l.item.value === first.current()) : -1;
    this.cursor = Math.max(0, i);
    this.remember();
  }

  get title(): string {
    return typeof this.heading === "function" ? this.heading() : this.heading;
  }

  private remember(): void {
    const sel = this.selectable()[this.cursor];
    this.on = sel && { section: sel.section, value: sel.item.value };
  }

  /** The items changed underneath the dialog (rows arriving while indexing): keep the cursor on the same item. */
  refresh(): void {
    const items = this.selectable();
    const at = this.on ? items.findIndex((l) => l.section === this.on!.section && l.item.value === this.on!.value) : -1;
    this.cursor = at >= 0 ? at : Math.min(this.cursor, Math.max(0, items.length - 1));
    this.remember();
  }

  private lines(filter = this.filter): Line[] {
    const q = filter.toLowerCase();
    const out: Line[] = [];
    for (const section of this.sections) {
      const items = section.items.filter((i) => !q || i.label.toLowerCase().includes(q));
      if (items.length === 0) continue;
      if (section.title) out.push({ kind: "title", text: section.title });
      for (const item of items) out.push({ kind: "item", section, item });
    }
    return out;
  }

  private selectable(): ItemLine[] {
    return this.lines().filter((l): l is ItemLine => l.kind === "item");
  }

  onKey(data: string): void {
    this.handleKey(data);
    this.remember();
  }

  private handleKey(data: string): void {
    const items = this.selectable();
    if (this.filtering) {
      if (isKey(data, "escape")) {
        this.filtering = false;
        this.filter = "";
      } else if (isKey(data, "enter") || isKey(data, "down")) this.filtering = false;
      else if (isKey(data, "backspace")) this.filter = this.filter.slice(0, -1);
      else if (isKey(data, "ctrl+u")) this.filter = "";
      else this.filter += typedText(data) ?? "";
      this.cursor = 0;
      return;
    }
    if (isKey(data, "escape") || isKey(data, "q")) {
      if (this.filter) {
        this.filter = "";
        this.cursor = 0;
      } else this.opts.onClose();
    } else if (isKey(data, "down") || isKey(data, "j")) this.cursor = Math.min(items.length - 1, this.cursor + 1);
    else if (isKey(data, "up") || isKey(data, "k")) this.cursor = Math.max(0, this.cursor - 1);
    else if (isKey(data, "home")) this.cursor = 0;
    else if (isKey(data, "end")) this.cursor = Math.max(0, items.length - 1);
    else if (isKey(data, "pageDown") || isKey(data, "ctrl+f")) this.cursor = Math.min(items.length - 1, this.cursor + this.window);
    else if (isKey(data, "pageUp") || isKey(data, "ctrl+b")) this.cursor = Math.max(0, this.cursor - this.window);
    else if (isKey(data, "ctrl+d")) this.cursor = Math.min(items.length - 1, this.cursor + Math.ceil(this.window / 2));
    else if (isKey(data, "ctrl+u")) this.cursor = Math.max(0, this.cursor - Math.ceil(this.window / 2));
    else if (data === "/" && this.opts.searchable) this.filtering = true;
    else if (isKey(data, "enter")) {
      const sel = items[this.cursor];
      if (sel) sel.section.apply(sel.item.value);
      this.opts.onClose();
    } else if (isKey(data, "space")) {
      const sel = items[this.cursor];
      if (sel) sel.section.apply(sel.item.value);
    }
  }

  /** One list line: the cursor, the dot for the chosen item, the label, and its count at the right edge. */
  private render(l: Line, on: boolean, inner: number): string {
    if (l.kind === "title") return st.bold(l.text);
    const current = l.section.current() === l.item.value;
    const head = `${on ? st.cyan("›") : " "} ${current ? st.green("●") : st.gray("○")} `;
    const hint = l.item.hint ? st.dim(`  ${l.item.hint}`) : "";
    const count = l.item.count !== undefined ? st.dim(String(l.item.count)) : "";
    const label = on ? st.bold(l.item.label) : l.item.label;
    // Counts line up in a column at the right edge, when the label leaves room for them.
    const gap = Math.max(2, inner - w(head) - w(label) - w(hint) - w(count));
    return `${head}${label}${hint}${count ? `${" ".repeat(gap)}${count}` : ""}`;
  }

  draw(width: number, maxHeight: number): string[] {
    const lines = this.lines();
    // The cursor counts items, and is matched by position: a section's items may be rebuilt on every read (the repo list is),
    // so the item objects of two reads are never the same objects.
    let itemNo = -1;
    const onCursor = lines.map((l) => l.kind === "item" && ++itemNo === this.cursor);
    // The whole list, filter or not, sets the box's size: typing in the filter only changes what is inside it.
    const all = this.lines("");
    const natural = Math.max(
      MIN_WIDTH,
      w(this.title) + 8,
      ...all.map((l) => (l.kind === "title" ? w(l.text) + 4 : w(l.item.label) + (l.item.hint ? w(l.item.hint) + 4 : 0) + (l.item.count !== undefined ? String(l.item.count).length + 2 : 0) + 8)),
    );
    const boxW = Math.min(width, natural + 2);
    const inner = boxW - 4;
    const chrome = 2 /* borders */ + 2 /* blank + footer */ + (this.opts.searchable ? 2 : 0) + 2 /* the meter and its blank line */;
    const room = Math.max(3, Math.min(this.opts.window ?? WINDOW, all.length, maxHeight - chrome));
    this.window = room;
    const rendered = lines.map((l, i) => this.render(l, onCursor[i]!, inner));
    const selLine = Math.max(0, onCursor.indexOf(true));
    const top = rendered.length > room ? Math.max(0, Math.min(selLine - Math.floor(room / 2), rendered.length - room)) : 0;
    const body = rendered.slice(top, top + room);
    if (rendered.length === 0) body.push(st.dim("  no matches"));
    while (body.length < room) body.push("");
    const items = this.selectable();
    const search = this.opts.searchable ? (this.filtering ? `${st.cyan("/")} ${this.filter}${st.inv(" ")}` : this.filter ? `${st.cyan("/")} ${this.filter}` : st.dim("/ to filter")) : "";
    const footer = st.dim(this.sections.length > 1 ? "enter choose+close · space choose · esc close" : "enter choose · esc close");
    // The meter row exists whenever the full list overflows, so it does not appear and vanish while filtering.
    const position = items.length > 1 && rendered.length > room ? `${meter(this.cursor, items.length)}  ${st.dim(`${this.cursor + 1}/${items.length}`)}` : "";
    return box(this.title, [...(search ? [search, ""] : []), ...body, ...(all.length > room ? [position, ""] : []), cut(footer, inner)], boxW);
  }
}
