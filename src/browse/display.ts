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

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad2 = (n: number): string => String(n).padStart(2, "0");
const isoDate = (d: Date): string => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const clock = (d: Date): string => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;

export type DateFormatId = "relative" | "smart" | "short" | "date" | "datetime";

export interface DateFormat {
  id: DateFormatId;
  label: string;
  /** What it looks like, for the settings dialog. */
  example: string;
  /** Column width the widest output needs. */
  width: number;
  format(ms: number, now: number): string;
}

/** The "Updated" column formats. All but `relative` show local time. */
export const DATE_FORMATS: readonly DateFormat[] = [
  { id: "relative", label: "relative", example: "5h ago · yesterday · Jul 14", width: 10, format: (ms, now) => ago(ms, now) },
  {
    id: "smart",
    label: "smart",
    example: "14:05 today · Jul 14 · 2025-07-14",
    width: 10,
    format(ms, now) {
      const d = new Date(ms);
      if (startOfDay(ms) === startOfDay(now)) return clock(d);
      return d.getFullYear() === new Date(now).getFullYear() ? `${MONTHS[d.getMonth()]} ${d.getDate()}` : isoDate(d);
    },
  },
  { id: "short", label: "short", example: "Jul 14 14:05", width: 12, format: (ms) => `${MONTHS[new Date(ms).getMonth()]} ${new Date(ms).getDate()} ${clock(new Date(ms))}` },
  { id: "date", label: "date", example: "2026-07-14", width: 10, format: (ms) => isoDate(new Date(ms)) },
  { id: "datetime", label: "date + time", example: "2026-07-14 14:05", width: 16, format: (ms) => `${isoDate(new Date(ms))} ${clock(new Date(ms))}` },
];

export const DEFAULT_DATE_FORMAT: DateFormatId = "relative";

export const dateFormat = (id: DateFormatId): DateFormat => DATE_FORMATS.find((f) => f.id === id) ?? DATE_FORMATS[0]!;

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
