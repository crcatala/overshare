/** Small display helpers for the session browser. */
import { formatDuration, plural } from "../format.js";
import type { SessionSummary } from "../sessions/summary.js";

export { plural };

/** "5h ago", "yesterday", "Jul 14". */
export function ago(ms: number, now = Date.now()): string {
  const s = Math.max(0, (now - ms) / 1000);
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  const d = Math.round(s / 86400);
  if (d === 1) return "yesterday";
  if (d < 14) return `${d}d ago`;
  if (d < 60) return `${Math.round(d / 7)}w ago`;
  return new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

const startOfDay = (ms: number): number => new Date(ms).setHours(0, 0, 0, 0);

/** Calendar-day buckets for grouping: Today / Yesterday / This week / This month / Older. */
export function dayBucket(ms: number, now = Date.now()): string {
  const d = Math.round((startOfDay(now) - startOfDay(ms)) / 86_400_000);
  if (d <= 0) return "Today";
  if (d === 1) return "Yesterday";
  if (d < 7) return "This week";
  if (d < 30) return "This month";
  return "Older";
}

export const shortModel = (m: string): string => m.replace(/^claude-/, "").replace(/^.*\//, "");

export function toolSummary(tools: Record<string, number>, max = 4): string {
  return Object.entries(tools)
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([n, c]) => `${n} ×${c}`)
    .join(" · ");
}

export function durationMs(s: Pick<SessionSummary, "startedAt" | "endedAt">): number {
  if (!s.startedAt || !s.endedAt) return 0;
  const ms = Date.parse(s.endedAt) - Date.parse(s.startedAt);
  return Number.isFinite(ms) && ms > 0 ? ms : 0;
}

export function sessionDuration(s: Pick<SessionSummary, "startedAt" | "endedAt">): string | undefined {
  const ms = durationMs(s);
  return ms > 0 ? formatDuration(ms) : undefined;
}
