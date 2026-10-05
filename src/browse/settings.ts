/**
 * Browser preferences, kept apart from the publish config: the TUI writes them whenever you change one, so they
 * live in their own file instead of rewriting a hand-edited `config.json`.
 *
 *   ~/.config/overshare/browse.json   (`OVERSHARE_BROWSE_SETTINGS` overrides)
 *   { "confirmQuit": true, "dateFormat": "relative", "viewer": { "indentReplies": false, "indentTools": false, "markers": "icon" } }
 *
 * Reading is forgiving (a missing, corrupt or partly invalid file falls back to defaults per field) because a
 * preference must never stop the browser from opening.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DATE_FORMATS, DEFAULT_DATE_FORMAT, type DateFormatId } from "./display.js";

export interface BrowseSettings {
  /** Ask "Quit?" before leaving the browser. */
  confirmQuit: boolean;
  /** How the list's "updated" column is written. */
  dateFormat: DateFormatId;
  viewer: {
    /** Indent assistant replies under the prompt they answer. */
    indentReplies: boolean;
    /** Indent tool calls (and thinking, subagents, events) one level deeper than the replies. */
    indentTools: boolean;
    /** How the message list marks each row's kind: a symbol (`❯`) or its name in brackets (`[User]`). */
    markers: MarkerStyle;
  };
}

export const MARKER_STYLES = ["icon", "text"] as const;
export type MarkerStyle = (typeof MARKER_STYLES)[number];

export const DEFAULT_SETTINGS: BrowseSettings = {
  confirmQuit: true,
  dateFormat: DEFAULT_DATE_FORMAT,
  viewer: { indentReplies: false, indentTools: false, markers: "icon" },
};

export type SettingsPatch = Partial<Omit<BrowseSettings, "viewer">> & { viewer?: Partial<BrowseSettings["viewer"]> };

const bool = (v: unknown, fallback: boolean): boolean => (typeof v === "boolean" ? v : fallback);

/** Keep every valid field of `raw`, default the rest. */
export function normalizeSettings(raw: unknown): BrowseSettings {
  const r = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const v = r.viewer && typeof r.viewer === "object" && !Array.isArray(r.viewer) ? (r.viewer as Record<string, unknown>) : {};
  return {
    confirmQuit: bool(r.confirmQuit, DEFAULT_SETTINGS.confirmQuit),
    dateFormat: DATE_FORMATS.some((f) => f.id === r.dateFormat) ? (r.dateFormat as DateFormatId) : DEFAULT_SETTINGS.dateFormat,
    viewer: {
      indentReplies: bool(v.indentReplies, DEFAULT_SETTINGS.viewer.indentReplies),
      indentTools: bool(v.indentTools, DEFAULT_SETTINGS.viewer.indentTools),
      markers: MARKER_STYLES.find((m) => m === v.markers) ?? DEFAULT_SETTINGS.viewer.markers,
    },
  };
}

export function settingsPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.OVERSHARE_BROWSE_SETTINGS ?? join(env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "overshare", "browse.json");
}

export interface SettingsStore {
  get(): BrowseSettings;
  /** Merge a change and persist it. Returns false when it could not be saved (the change still applies for this run). */
  update(patch: SettingsPatch): boolean;
}

function merge(current: BrowseSettings, patch: SettingsPatch): BrowseSettings {
  return normalizeSettings({ ...current, ...patch, viewer: { ...current.viewer, ...patch.viewer } });
}

/** Settings that live only in memory (tests, or when the file cannot be used). */
export function memorySettings(initial: SettingsPatch = {}): SettingsStore {
  let value = merge(DEFAULT_SETTINGS, initial);
  return {
    get: () => value,
    update(patch) {
      value = merge(value, patch);
      return true;
    },
  };
}

/** What the footer says when a preference could not be written (it still applies until the browser closes). */
export const SAVE_FAILED_MESSAGE = "could not save settings; they apply until you quit";

/** The file's settings, or undefined when it is missing or not valid JSON. */
function readSettings(path: string): BrowseSettings | undefined {
  try {
    return normalizeSettings(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return undefined;
  }
}

export function loadSettings(path = settingsPath()): BrowseSettings {
  return readSettings(path) ?? normalizeSettings(undefined);
}

/**
 * Settings backed by a JSON file (atomic write). Each change is applied on top of what the file holds *now*, not on
 * what it held at startup, so a second browser open at the same time does not get its other settings overwritten
 * with stale values. (Two writes in the same instant can still race; for preferences that is not worth a lock.)
 */
export function fileSettings(path = settingsPath()): SettingsStore {
  let value = loadSettings(path);
  // After a failed write memory is ahead of the file: keep building on memory until a write succeeds.
  let unsaved = false;
  return {
    get: () => value,
    update(patch) {
      value = merge((!unsaved && readSettings(path)) || value, patch);
      try {
        mkdirSync(dirname(path), { recursive: true });
        const tmp = `${path}.${process.pid}.tmp`;
        writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
        renameSync(tmp, path);
        unsaved = false;
        return true;
      } catch {
        unsaved = true;
        return false;
      }
    },
  };
}
