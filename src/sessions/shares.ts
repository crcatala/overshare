/**
 * Which sessions have been published, so a browser can mark them and never share one twice by accident.
 * `~/.local/state/overshare/shares.json`: `{ "<harness>:<sessionId>": ShareRecord[] }`.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { PRIVATE_DIR_MODE, PRIVATE_FILE_MODE } from "./private-files.js";
import { stripControls } from "../sanitize.js";
import type { ShareTarget } from "../config.js";
import type { HarnessName, ShareMode } from "../schema.js";

export interface ShareRecord {
  url: string;
  mode: ShareMode;
  target: ShareTarget;
  sharedAt: string;
}

export type SharesFile = Record<string, ShareRecord[]>;

export function sharesPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.OVERSHARE_SHARES ?? join(env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "overshare", "shares.json");
}

export const shareKey = (harness: HarnessName, id: string): string => `${harness}:${id}`;

export function loadShares(path = sharesPath()): SharesFile {
  try {
    const data = JSON.parse(readFileSync(path, "utf8"));
    return data && typeof data === "object" && !Array.isArray(data) ? (data as SharesFile) : {};
  } catch {
    return {};
  }
}

/** Append a record (atomic write). Never throws: failing to remember a share must not fail the publish. */
export function recordShare(harness: HarnessName, id: string, record: ShareRecord, path = sharesPath()): boolean {
  try {
    const all = loadShares(path);
    const key = shareKey(harness, id);
    all[key] = [...(all[key] ?? []), record];
    mkdirSync(dirname(path), { recursive: true, mode: PRIVATE_DIR_MODE });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(all, null, 2)}\n`, { mode: PRIVATE_FILE_MODE });
    renameSync(tmp, path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Drop every record `matches` selects (atomic write; a key left with no records is removed).
 * Never throws: a share that is already gone from the remote must not turn a delete into a failure.
 * Returns false when `shares.json` exists but could not be read or rewritten (the caller should warn);
 * a missing file or no matching record is a normal no-op and returns true.
 */
export function removeShares(matches: (record: ShareRecord) => boolean, path = sharesPath()): boolean {
  try {
    let all: SharesFile;
    try {
      all = JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
      return false;
    }
    if (!all || typeof all !== "object" || Array.isArray(all)) return false;
    let changed = false;
    for (const [key, records] of Object.entries(all)) {
      if (!Array.isArray(records)) continue;
      const kept = records.filter((r) => !matches(r));
      if (kept.length === records.length) continue;
      changed = true;
      if (kept.length) all[key] = kept;
      else delete all[key];
    }
    if (!changed) return true;
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(all, null, 2)}\n`, { mode: PRIVATE_FILE_MODE });
    renameSync(tmp, path);
    return true;
  } catch {
    return false;
  }
}

export const sharesFor = (all: SharesFile, harness: HarnessName, id: string): ShareRecord[] => all[shareKey(harness, id)] ?? [];

/**
 * A session's newest share with a usable link, and how many records came before it. `shares.json` is ours but sits on disk
 * where anything can edit it, so the link is untrusted text: terminal sequences, control characters and whitespace (a URL
 * has none) are removed. The browser prints and copies this same string, so a pasted link is exactly the one on screen and
 * cannot carry a newline into a shell.
 */
export function latestShare(all: SharesFile, harness: HarnessName, id: string): { record: ShareRecord; link: string; earlier: number } | undefined {
  const records = sharesFor(all, harness, id);
  if (!Array.isArray(records)) return undefined;
  for (let i = records.length - 1; i >= 0; i--) {
    const record = records[i];
    const link = typeof record?.url === "string" ? stripControls(record.url).replace(/\s/g, "") : "";
    if (record && link) return { record, link, earlier: i };
  }
  return undefined;
}
