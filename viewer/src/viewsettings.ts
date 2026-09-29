/**
 * View settings: how a session is shown (design variant, detail, theme, which rails are
 * open, how much the contents rail lists), as opposed to which session. Where they come from:
 *   1. `&ui=` in the link, per field, over whatever the tab would otherwise show; read
 *      when the link opens and then dropped from the address bar
 *   2. this tab's settings (sessionStorage), so a reload keeps what the reader was looking
 *      at. The tab stores every field, so once it has settings a default saved later (in
 *      another tab, say) only applies to new tabs.
 *   3. the reader's saved default (localStorage; "Save as my default" in the settings menu)
 *   4. BUILT_IN
 * Changing a setting updates only this tab's copy; the URL never tracks it.
 */
import { availableModes } from "../../src/modes.ts";
import type { ShareMode } from "../../src/schema.ts";
import { DEFAULT_VARIANT, findVariant, type VariantId } from "./variants.ts";

export type Theme = "system" | "light" | "dark";
/** What the contents rail lists: one row per prompt, or also the steps inside each turn. */
export type TocDetail = "prompts" | "all";

export interface ViewSettings {
  variant: VariantId;
  /** The detail wanted; a share published with less shows its most (see viewFor). */
  view: ShareMode;
  theme: Theme;
  /** Rails open while docked. Narrow windows always start with both closed. */
  left: boolean;
  right: boolean;
  toc: TocDetail;
}

export const BUILT_IN: ViewSettings = { variant: DEFAULT_VARIANT, view: "full", theme: "system", left: true, right: true, toc: "prompts" };

const VIEWS: readonly string[] = ["full", "brief", "minimal"] satisfies ShareMode[];
const THEMES: readonly string[] = ["system", "light", "dark"] satisfies Theme[];
const RAILS: Record<string, [left: boolean, right: boolean]> = { LR: [true, true], L: [true, false], R: [false, true], "-": [false, false] };

/**
 * Read a `&ui=` value: dot-separated tokens that each say what they are (a variant id, a
 * view, a theme, the open rails as LR/L/R/-, or toc-prompts/toc-all), in any order. Unknown tokens are skipped,
 * so renaming or removing an option only drops that field back to the reader's own
 * setting. To keep old links working after a rename, accept the old name here too.
 */
export function parseUi(value: string | null | undefined): Partial<ViewSettings> {
  const out: Partial<ViewSettings> = {};
  for (const token of value ? value.split(".") : []) {
    const variant = findVariant(token);
    if (variant) out.variant = variant.id;
    else if (VIEWS.includes(token)) out.view = token as ShareMode;
    else if (THEMES.includes(token)) out.theme = token as Theme;
    else if (Object.hasOwn(RAILS, token)) [out.left, out.right] = RAILS[token]!;
    else if (token === "toc-prompts" || token === "toc-all") out.toc = token.slice(4) as TocDetail;
  }
  return out;
}

/** The `&ui=` value for these settings, e.g. `log.brief.dark.L.toc-all`. */
export function formatUi(s: ViewSettings): string {
  const rails = s.left ? (s.right ? "LR" : "L") : s.right ? "R" : "-";
  return [s.variant, s.view, s.theme, rails, `toc-${s.toc}`].join(".");
}

/** The settings in words, e.g. "log · brief · dark · contents rail · contents: all". */
export function describe(s: ViewSettings): string {
  const rails = s.left ? (s.right ? "both rails" : "contents rail") : s.right ? "tokens rail" : "no rails";
  return [s.variant, s.view, s.theme === "system" ? "system theme" : s.theme, rails, s.toc === "all" ? "contents: all" : ""].filter(Boolean).join(" · ");
}

export function sameSettings(a: ViewSettings, b: ViewSettings): boolean {
  return formatUi(a) === formatUi(b);
}

/** Layer the sources, first wins per field (see the top of this file). */
export function resolve(link: Partial<ViewSettings>, tab: Partial<ViewSettings>, saved: Partial<ViewSettings>): ViewSettings {
  return { ...BUILT_IN, ...saved, ...tab, ...link };
}

/** The view to show: the one wanted if the share has it, else the most detail it was published with. */
export function viewFor(wanted: ShareMode, sharedMode: ShareMode): ShareMode {
  return availableModes(sharedMode).includes(wanted) ? wanted : sharedMode;
}

/**
 * The view to keep for one shown on a share: the most it has means "as much as there
 * is", kept as "full", so a brief share doesn't hold every later share to brief.
 */
export function wantedView(shown: ShareMode, sharedMode: ShareMode): ShareMode {
  return shown === sharedMode ? "full" : shown;
}

export interface DefaultsState {
  /** The saved default in words, or undefined when there is none. */
  saved?: string;
  /** What's showing differs from the default in effect (saved, or built-in). */
  canSave: boolean;
  /** There is a saved default, or what's showing differs from the built-in one. */
  canReset: boolean;
}

/** What the settings menu can offer for saving `current` as the default, given the one saved (if any). */
export function defaultsState(current: ViewSettings, saved: Partial<ViewSettings> | undefined): DefaultsState {
  const effective = resolve({}, {}, saved ?? {});
  return {
    saved: saved ? describe(effective) : undefined,
    canSave: !sameSettings(effective, current),
    canReset: Boolean(saved) || !sameSettings(BUILT_IN, current),
  };
}

// ---------- storage ----------
// Both keys hold a `&ui=` value, so they read back through the same forgiving parser.
const SAVED_KEY = "agent-share-default-view";
const TAB_KEY = "agent-share-view";

function read(store: () => Storage, key: string): string | null {
  try {
    return store().getItem(key);
  } catch {
    return null; // storage unavailable (private mode, sandbox)
  }
}

function write(store: () => Storage, key: string, value: string | null): void {
  try {
    if (value === null) store().removeItem(key);
    else store().setItem(key, value);
  } catch {
    // storage unavailable
  }
}

const local = () => localStorage;
const session = () => sessionStorage;

/** The reader's saved default, or undefined when they haven't saved one. */
export function loadSaved(): Partial<ViewSettings> | undefined {
  const value = read(local, SAVED_KEY);
  return value === null ? undefined : parseUi(value);
}

export function saveDefault(s: ViewSettings | null): void {
  write(local, SAVED_KEY, s && formatUi(s));
}

export function loadTab(): Partial<ViewSettings> {
  return parseUi(read(session, TAB_KEY));
}

export function saveTab(s: ViewSettings): void {
  write(session, TAB_KEY, formatUi(s));
}
