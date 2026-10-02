/**
 * Browser preferences, kept apart from the publish config: the TUI writes them whenever you change one, so they
 * live in their own file instead of rewriting a hand-edited `config.json`.
 *
 *   ~/.config/agent-share/browse.json   (`AGENT_SHARE_BROWSE_SETTINGS` overrides)
 *   { "confirmQuit": true, "dateFormat": "relative", "viewer": { "indentReplies": false, "indentTools": false } }
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
  };
}

export const DEFAULT_SETTINGS: BrowseSettings = {
  confirmQuit: true,
  dateFormat: DEFAULT_DATE_FORMAT,
  viewer: { indentReplies: false, indentTools: false },
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
    },
  };
}

export function settingsPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.AGENT_SHARE_BROWSE_SETTINGS ?? join(env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "agent-share", "browse.json");
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

export function loadSettings(path = settingsPath()): BrowseSettings {
  try {
    return normalizeSettings(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return normalizeSettings(undefined);
  }
}

/** Settings backed by a JSON file (atomic write). Reads once; this process is the only writer while the browser runs. */
export function fileSettings(path = settingsPath()): SettingsStore {
  let value = loadSettings(path);
  return {
    get: () => value,
    update(patch) {
      value = merge(value, patch);
      try {
        mkdirSync(dirname(path), { recursive: true });
        const tmp = `${path}.${process.pid}.tmp`;
        writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
        renameSync(tmp, path);
        return true;
      } catch {
        return false;
      }
    },
  };
}
