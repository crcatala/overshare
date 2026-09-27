import type { HarnessName } from "../schema.js";
import { parseClaudeCode } from "./claude-code.js";
import { parsePi } from "./pi.js";
import type { AdapterOptions, AdapterResult } from "./shared.js";

export type { AdapterOptions, AdapterResult } from "./shared.js";

export interface Adapter {
  name: HarnessName;
  /** True when the raw transcript looks like this harness's format. */
  detect(firstEntry: Record<string, unknown>): boolean;
  parse(raw: string, options?: AdapterOptions): AdapterResult;
}

/**
 * Registered harness adapters. To support a new harness, add an adapter that maps its
 * native transcript to `NormalizedSession` and register it here (and in `resolve.ts`
 * if its sessions should be discoverable by id / `--current`).
 */
export const ADAPTERS: Adapter[] = [
  { name: "pi", detect: (e) => e.type === "session" && typeof e.version === "number", parse: parsePi },
  {
    name: "claude-code",
    detect: (e) => typeof e.sessionId === "string" || typeof e.uuid === "string" || e.type === "summary",
    parse: parseClaudeCode,
  },
];

export function detectHarness(raw: string): HarnessName | undefined {
  for (const line of raw.split("\n", 50)) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const match = ADAPTERS.find((a) => a.detect(entry));
    if (match) return match.name;
  }
  return undefined;
}

export function parseSession(raw: string, harness?: HarnessName, options?: AdapterOptions): AdapterResult {
  const name = harness ?? detectHarness(raw);
  const adapter = ADAPTERS.find((a) => a.name === name);
  if (!adapter) throw new Error("Could not detect the transcript format (supported: claude-code, pi)");
  return adapter.parse(raw, options);
}
