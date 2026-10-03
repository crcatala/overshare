/** Fakes and drivers for the browse TUI tests: a programmable Source, a fixed clock, raw key bytes. */
process.env.TZ = "UTC"; // day buckets ("Today", "Yesterday") depend on the local calendar

import { vi } from "vitest";
import { BrowserApp, type BrowserOptions } from "../src/browse/app.js";
import { plainText } from "../src/browse/kit.js";
import type { IndexFeed, Preflight, SessionView, ShareReview, ShareSummary, Source, ViewItem } from "../src/browse/source.js";
import type { ShareMode } from "../src/schema.js";
import type { SharesFile } from "../src/sessions/shares.js";
import { shareKey } from "../src/sessions/shares.js";
import type { SessionSummary } from "../src/sessions/summary.js";

export const KEY = {
  enter: "\r",
  esc: "\x1b",
  down: "\x1b[B",
  up: "\x1b[A",
  space: " ",
  backspace: "\x7f",
  pageDown: "\x1b[6~",
  pageUp: "\x1b[5~",
  ctrlF: "\x06",
  ctrlB: "\x02",
  ctrlD: "\x04",
  ctrlU: "\x15",
  end: "\x1b[F",
} as const;

/** Wednesday 2026-09-30 12:00 UTC. */
export const NOW = Date.UTC(2026, 8, 30, 12);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export function summary(over: Partial<SessionSummary> & { id: string }): SessionSummary {
  const mtimeMs = over.mtimeMs ?? NOW - HOUR;
  return {
    harness: "claude-code",
    path: `/sessions/${over.id}.jsonl`,
    mtimeMs,
    size: 100_000,
    cwd: "/home/me/work/app",
    project: "app",
    models: ["claude-opus-5-5"],
    prompts: 3,
    calls: 10,
    tools: { Bash: 4 },
    subagents: 0,
    worker: false,
    promptHead: ["first prompt"],
    promptTail: [],
    firstPrompt: "first prompt",
    lastPrompt: "last prompt",
    startedAt: new Date(mtimeMs - 30 * 60_000).toISOString(),
    endedAt: new Date(mtimeMs).toISOString(),
    searchText: `${over.title ?? ""}\n${over.project ?? "app"}\n${over.firstPrompt ?? "first prompt"}`.toLowerCase(),
    ...over,
  };
}

/** Eight sessions over four repos, two harnesses and three days, with distinct sizes and titles. */
export function sampleSessions(): SessionSummary[] {
  return [
    summary({ id: "s1", title: "Fix invoice currency bug", project: "billing", mtimeMs: NOW - HOUR, size: 900_000, prompts: 9, firstPrompt: "POST /v1/invoices returns 500" }),
    summary({ id: "s2", harness: "pi", title: "Refactor money helpers", project: "billing", mtimeMs: NOW - 3 * HOUR, size: 300_000, prompts: 4, models: ["gpt-6.1-sol"], tools: { bash: 9, read: 3 } }),
    summary({ id: "s3", title: "Onboarding empty state", project: "web", mtimeMs: NOW - DAY - 30 * 60_000, size: 50_000, prompts: 2 }),
    summary({ id: "s4", harness: "pi", title: "Auth token refresh race", project: "auth", mtimeMs: NOW - DAY - HOUR, size: 700_000, prompts: 12, tools: { bash: 30 } }),
    summary({ id: "s5", title: "Bucket policy for R2", project: "infra", mtimeMs: NOW - 3 * DAY, size: 120_000, prompts: 5 }),
    summary({ id: "s6", harness: "pi", title: "Compare terminal multiplexers", project: "web", mtimeMs: NOW - 10 * DAY, size: 20_000, prompts: 3 }),
    summary({ id: "s7", title: "Write the worktree playbook", project: "infra", mtimeMs: NOW - 40 * DAY, size: 10_000, prompts: 6 }),
    summary({ id: "w1", harness: "pi", title: "subagent-worker-1", project: "billing", worker: true, mtimeMs: NOW - 2 * HOUR }),
  ];
}

export function sampleView(): SessionView {
  const items: ViewItem[] = [
    { kind: "user", turn: 1, label: "fix the bug", body: "fix the bug in the invoice handler" },
    { kind: "thinking", turn: 1, label: "thinking (800 chars)", body: "let me look" },
    { kind: "tool", turn: 1, label: "Bash  npm test", meta: "Bash", body: "npm test\n\n── result ──\n12 passed" },
    { kind: "tool", turn: 1, label: "Edit  src/invoice.ts", meta: "Edit", body: "src/invoice.ts", error: true },
    { kind: "assistant", turn: 1, label: "Fixed: the default currency was missing.", body: "Fixed: the default currency was missing.\n\nDetails follow." },
    { kind: "user", turn: 2, label: "now add a test", body: "now add a test for the USD fallback" },
    { kind: "tool", turn: 2, label: "Write  tests/invoice.test.ts", meta: "Write", body: "tests/invoice.test.ts" },
    { kind: "assistant", turn: 2, label: "Added the regression test.", body: "Added the regression test." },
  ];
  return { items, turns: 2, tools: { Bash: 12, Edit: 3, Read: 7 }, stats: { cost: "$1.20", tokens: "2.1M", duration: "32m 0s", toolCalls: 22, subagents: 0, files: { read: 7, edited: 3, written: 1 } } };
}

const clean = (mode: ShareMode): ShareReview => ({ mode, clean: true, blocked: false, findings: [], suspicious: [], knownSources: [], redactions: 0, bytes: 12_345 });

/** What the list has for a session before its file is read: the stat fields only (see `IndexJob`). */
export function placeholderOf(s: SessionSummary): SessionSummary {
  return { harness: s.harness, id: s.id, path: s.path, mtimeMs: s.mtimeMs, size: s.size, models: [], prompts: 0, calls: 0, tools: {}, subagents: 0, worker: false, promptHead: [], promptTail: [], searchText: "", pending: true };
}

/** A promise the test settles by hand, to hold a view or review "in flight". */
export function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(err: unknown): void } {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** What a cancellable source call does: settle with `work`, or reject at once when `signal` aborts (the work may still finish). */
function abortable<T>(signal: AbortSignal, work: () => Promise<T>, ignoreAbort = false): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(Object.assign(new Error("cancelled"), { name: "AbortError" }));
    if (!ignoreAbort) {
      if (signal.aborted) return abort();
      signal.addEventListener("abort", abort, { once: true });
    }
    work().then(resolve, reject);
  });
}

export interface FakeSourceOptions {
  sessions?: SessionSummary[];
  /** Ids that start as stat-only placeholders; `source.fill(id)` reads one, like the index would. */
  pending?: string[];
  /** Use this index feed (e.g. a real `IndexJob` whose `sessions` are passed too) instead of the fake one. */
  index?: IndexFeed;
  shares?: SharesFile;
  /** A source that keeps going after its signal aborts and delivers the answer anyway: the browser must drop it itself. */
  ignoreAbort?: boolean;
  /** May return a promise that the test settles later (`deferred()`); may throw. */
  view?: (s: SessionSummary, signal: AbortSignal) => SessionView | Promise<SessionView>;
  /** May return a promise that the test settles later (`deferred()`); may throw (a refusal). */
  review?: (s: SessionSummary, mode: ShareMode, signal: AbortSignal) => ShareReview | Promise<ShareReview>;
  preflight?: () => Preflight;
  publish?: (s: SessionSummary, mode: ShareMode) => Promise<{ url: string; warnings: string[] }>;
}

export interface FakeSource extends Source {
  published: Array<{ id: string; mode: ShareMode }>;
  /** `suspiciousConfirmed` as passed to each `publish`, in order. */
  suspiciousConfirmed: Array<boolean | undefined>;
  /** The id of the review each `publish` was given, in order. */
  publishedReviewIds: string[];
  /** Every `review` call, with the signal the caller can abort. */
  reviewed: Array<{ id: string; mode: ShareMode }>;
  reviewSignals: AbortSignal[];
  /** Every `view` call's session id and signal. */
  viewed: Array<{ id: string; signal: AbortSignal }>;
  /** `close` was called (the browser quit). */
  closed: boolean;
  /** The index finished reading `id`: swap in its full summary and notify the browser. */
  fill(id: string): void;
  /** Whether the browser told the index to stop (it quit). */
  stopped: boolean;
}

export function fakeSource(opts: FakeSourceOptions = {}): FakeSource {
  const shares: SharesFile = opts.shares ?? {};
  const published: FakeSource["published"] = [];
  const reviewed: FakeSource["reviewed"] = [];
  const suspiciousConfirmed: FakeSource["suspiciousConfirmed"] = [];
  const publishedReviewIds: string[] = [];
  const reviewSignals: AbortSignal[] = [];
  const viewed: FakeSource["viewed"] = [];
  /** The review each (session, mode) was last given, like the real source's cache: older ones cannot be published. */
  const latest = new Map<string, string>();
  let reviewCount = 0;
  const full = opts.sessions ?? sampleSessions();
  const sessions = full.map((s) => (opts.pending?.includes(s.id) ? placeholderOf(s) : s));
  const listeners = new Set<() => void>();
  const feed: IndexFeed | undefined = opts.pending
    ? {
        progress: () => {
          const left = sessions.filter((s) => s.pending).length;
          return left ? { done: sessions.length - left, total: sessions.length } : undefined;
        },
        subscribe: (l) => {
          listeners.add(l);
          return () => void listeners.delete(l);
        },
        stop: () => {
          source.stopped = true;
        },
      }
    : opts.index;
  const source: FakeSource = {
    sessions: opts.index ? full : sessions,
    index: feed,
    stopped: false,
    fill(id) {
      const at = sessions.findIndex((s) => s.id === id);
      sessions[at] = full.find((s) => s.id === id)!;
      for (const l of listeners) l();
    },
    shares,
    destination: "a secret (unlisted) gist",
    published,
    suspiciousConfirmed,
    publishedReviewIds,
    reviewed,
    reviewSignals,
    viewed,
    closed: false,
    view(s, signal) {
      viewed.push({ id: s.id, signal });
      return abortable(signal, async () => (opts.view ?? (() => sampleView()))(s, signal), opts.ignoreAbort);
    },
    review(s, mode, signal) {
      reviewed.push({ id: s.id, mode });
      reviewSignals.push(signal);
      return abortable(signal, async () => {
        const review = await (opts.review ?? ((_, m) => clean(m)))(s, mode, signal);
        const id = `review-${++reviewCount}`;
        latest.set(`${s.id}|${mode}`, id);
        return { id, ...review };
      }, opts.ignoreAbort);
    },
    preflight: opts.preflight ?? (() => ({ warnings: [] })),
    close() {
      source.closed = true;
    },
    async publish(s, mode, publishOpts) {
      publishedReviewIds.push(publishOpts.reviewId);
      if (latest.get(`${s.id}|${mode}`) !== publishOpts.reviewId) throw new Error("The reviewed payload is no longer available; go back and review it again before publishing.");
      published.push({ id: s.id, mode });
      suspiciousConfirmed.push(publishOpts.suspiciousConfirmed);
      const out = await (opts.publish ?? (async () => ({ url: `https://viewer.example/#${s.id}`, warnings: [] })))(s, mode);
      (shares[shareKey(s.harness, s.id)] ??= []).push({ url: out.url, mode, target: "gist", sharedAt: new Date(NOW).toISOString() });
      return out;
    },
  };
  return source;
}

export interface Driver {
  app: BrowserApp;
  source: FakeSource;
  /** Send raw key bytes, one per argument, then let timers/promises settle. */
  press(...keys: string[]): Promise<void>;
  /** Type text as individual keys. */
  type(text: string): Promise<void>;
  /** The screen as plain text lines at the given size. */
  lines(width?: number, height?: number): string[];
  text(width?: number, height?: number): string;
}

/** A browser over a fake source with a frozen clock (call `vi.useFakeTimers()` in the test file). */
export function drive(opts: FakeSourceOptions & BrowserOptions = {}): Driver {
  const source = fakeSource(opts);
  const app = new BrowserApp(source, { now: () => NOW, query: opts.query, harness: opts.harness, settings: opts.settings });
  app.attach(() => 34, () => {});
  const lines = (width = 130, height = 34) => {
    app.attach(() => height, () => {});
    return app.render(width).map(plainText);
  };
  return {
    app,
    source,
    async press(...keys) {
      for (const k of keys) {
        app.handleInput(k);
        await vi.advanceTimersByTimeAsync(300);
      }
    },
    async type(text) {
      for (const ch of text) {
        app.handleInput(ch);
      }
      await vi.advanceTimersByTimeAsync(0);
    },
    lines,
    text: (width, height) => lines(width, height).join("\n"),
  };
}

/** The list column only (left of the preview separator), one string per line. */
export function listColumn(lines: string[]): string[] {
  return lines.map((l) => l.split(" │ ")[0]!);
}

/** Session titles in the order the list shows them. */
export function order(lines: string[], titles: string[]): string[] {
  const col = listColumn(lines);
  return titles.map((t) => ({ t, at: col.findIndex((l) => l.includes(t)) })).filter((x) => x.at >= 0).sort((a, b) => a.at - b.at).map((x) => x.t);
}

export const TITLES = sampleSessions().map((s) => s.title!);

/** `n` sessions, newest first, titled "Session number 000" …, alternating harness so a filter changes the list. */
export function manySessions(n: number): SessionSummary[] {
  return Array.from({ length: n }, (_, i) =>
    summary({ id: `m${i}`, harness: i % 2 ? "pi" : "claude-code", title: `Session number ${String(i).padStart(3, "0")}`, mtimeMs: Date.UTC(2026, 8, 30) - i * HOUR }),
  );
}

/** The number of the selected `manySessions` row (the one with the ▌ marker), if it is on screen. */
export function selectedNumber(lines: string[]): number | undefined {
  const m = listColumn(lines).find((l) => l.includes("▌"))?.match(/Session number (\d+)/);
  return m ? Number(m[1]) : undefined;
}

/** The viewer's two panels, side by side: each screen line split at the gap between their borders. */
export function viewerPanes(lines: string[]): { left: string[]; right: string[] } {
  const split = lines.map((l) => {
    const m = l.match(/[│╮╯] [│╭╰]/);
    return m ? [l.slice(0, m.index! + 1), l.slice(m.index! + 2)] : [l, ""];
  });
  return { left: split.map((x) => x[0]!), right: split.map((x) => x[1]!) };
}
