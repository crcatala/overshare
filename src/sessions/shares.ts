/**
 * Which sessions have been published, so a browser can mark them and never share one twice by accident.
 * `~/.local/state/agent-share-session/shares.json`: `{ "<harness>:<sessionId>": ShareRecord[] }`.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
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
  return env.AGENT_SHARE_SHARES ?? join(env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "agent-share-session", "shares.json");
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
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(all, null, 2)}\n`);
    renameSync(tmp, path);
    return true;
  } catch {
    return false;
  }
}

export const sharesFor = (all: SharesFile, harness: HarnessName, id: string): ShareRecord[] => all[shareKey(harness, id)] ?? [];
