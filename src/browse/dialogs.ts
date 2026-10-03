/**
 * Radio-list dialog: one or more titled sections of single-choice items. Backs the Shift+key dialogs
 * (repo, harness, time, shared, group, sort, message list).
 *
 *   ↑/↓ j/k  move        enter  choose + close        space  choose, stay open (handy for sort)
 *   /        filter the list (searchable dialogs)     esc    close (or leave the filter first)
 */
import { box, cut, isKey, st, w } from "./kit.js";

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
  /** The item under the cursor, so `refresh` can put the cursor back on it when the items change. */
  private on?: { section: DialogSection; value: unknown };

  constructor(
    private readonly heading: string | (() => string),
    readonly sections: DialogSection[],
    readonly opts: { searchable?: boolean; onClose: () => void },
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

  private lines(): Line[] {
    const q = this.filter.toLowerCase();
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
      else if (!data.startsWith("\x1b") && data >= " ") this.filter += data;
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

  draw(width: number, maxHeight: number): string[] {
    const lines = this.lines();
    const sel = this.selectable()[this.cursor];
    const isSel = (l: ItemLine) => sel !== undefined && l.section === sel.section && l.item === sel.item;
    const rendered = lines.map((l) => {
      if (l.kind === "title") return st.bold(l.text);
      const on = isSel(l);
      const current = l.section.current() === l.item.value;
      return `${on ? st.cyan("›") : " "} ${current ? st.green("●") : st.gray("○")} ${on ? st.bold(l.item.label) : l.item.label}${l.item.count !== undefined ? st.dim(`  ${l.item.count}`) : ""}${l.item.hint ? st.dim(`  ${l.item.hint}`) : ""}`;
    });
    const selLine = Math.max(0, lines.findIndex((l) => l.kind === "item" && isSel(l)));
    const room = Math.max(3, maxHeight - 6 - (this.opts.searchable ? 2 : 0));
    let top = 0;
    if (rendered.length > room) top = Math.max(0, Math.min(selLine - Math.floor(room / 2), rendered.length - room));
    const body = rendered.slice(top, top + room);
    if (rendered.length === 0) body.push(st.dim("  no matches"));
    if (top > 0) body[0] = st.dim(`  ↑ ${top} more`);
    if (top + room < rendered.length) body[body.length - 1] = st.dim(`  ↓ ${rendered.length - top - room} more`);
    const search = this.opts.searchable ? (this.filtering ? `${st.cyan("/")} ${this.filter}${st.inv(" ")}` : this.filter ? `${st.cyan("/")} ${this.filter}` : st.dim("/ to filter")) : "";
    const footer = st.dim(this.sections.length > 1 ? "enter choose+close · space choose · esc close" : "enter choose · esc close");
    const natural = Math.max(36, w(this.title) + 8, ...lines.map((l) => (l.kind === "title" ? w(l.text) : w(l.item.label) + (l.item.hint ? w(l.item.hint) + 4 : 0) + 10)), w(footer) + 4) + 2;
    const width2 = Math.min(width, natural);
    return box(this.title, [...(search ? [search, ""] : []), ...body, "", cut(footer, width2 - 4)], width2);
  }
}
