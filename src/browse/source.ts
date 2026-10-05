/**
 * What the browser reads and does, behind one interface so the UI can be tested without a disk, a network
 * or the redaction pipeline.
 *
 *   view     the session as a local message list (parse only, unredacted: it is the user's own machine)
 *   review   the real publish pipeline for one share mode and target: redaction findings, final re-scan, payload size
 *   publish  upload exactly what `review` showed (cached), then remember it in shares.json
 *
 * The target (gist or R2) is a per-publish choice: `Source.target` is the configured default the dialog starts on, and
 * every call that depends on the destination takes the one in play. Nothing here writes a target back to the config.
 *
 * `view` and `review` are asynchronous and cancellable: the heavy work runs on a worker thread (see `runner.ts`),
 * so the UI keeps drawing and handling keys. A caller that no longer wants the answer aborts its signal, and must
 * ignore a result that arrives anyway.
 */
import { randomUUID } from "node:crypto";
import type { OvershareConfig, ShareTarget } from "../config.js";
import { createPublisher, preflightWarnings, publishPrepared } from "../publish/index.js";
import type { Publisher } from "../publish/types.js";
import type { KnownSourceUse } from "../redact/known-values.js";
import type { ShareMode } from "../schema.js";
import { shareKey, type SharesFile, loadShares } from "../sessions/shares.js";
import type { SessionSummary } from "../sessions/summary.js";
import type { PublishSession } from "./job.js";
import { abortError, workerRunner, type JobRunner } from "./runner.js";

export type ViewKind = "user" | "assistant" | "tool" | "thinking" | "subagent" | "event";

/**
 * A piece of a message the right pane draws with its own formatting (see render.ts). Plain data, so it crosses the
 * worker boundary; all text is already stripped of control sequences and capped.
 */
export type ViewBlock = (
  | { type: "markdown"; text: string }
  | { type: "text"; text: string; style?: "dim" | "error" }
  /** A small heading for the part that follows ("result", "error"). */
  | { type: "label"; text: string; style?: "error" }
  | { type: "code"; text: string; lang?: string }
  /** One or more replacements in a file, drawn as a diff. */
  | { type: "edit"; path?: string; edits: Array<{ old: string; new: string }> }
) & {
  /** Part of what a tool or subagent returned, not of the call: a search leaves it out unless asked. */
  output?: true;
};

/** One row of the viewer's message list, with its full content for the right pane. */
export interface ViewItem {
  kind: ViewKind;
  /** 1-based turn number (a turn starts at a user prompt). */
  turn: number;
  /** One line for the list. */
  label: string;
  /** Full content (truncated for huge tool input/output). Plain text: what `y` copies, and what the pane shows when there are no `blocks`. */
  body: string;
  /** The same content cut into formatted pieces, for tool calls and subagents; other kinds are drawn from `body` by kind. */
  blocks?: ViewBlock[];
  /** Short qualifier for the content title: tool name, event kind, model. */
  meta?: string;
  error?: boolean;
}

export interface SessionStatsLine {
  cost?: string;
  tokens: string;
  duration?: string;
  toolCalls: number;
  subagents: number;
  files: { read: number; edited: number; written: number };
}

export interface SessionView {
  items: ViewItem[];
  turns: number;
  /** Tool call counts by name (includes subagent tools). */
  tools: Record<string, number>;
  stats: SessionStatsLine;
}

export interface ShareReview {
  mode: ShareMode;
  clean: boolean;
  /** The final re-scan found unredacted secrets: publishing must be refused. */
  blocked: boolean;
  findings: Array<{ rule: string; where: string }>;
  /** What the final re-scan found (never the value): why publishing is refused when `blocked`. `lines` are lines of the transcript file. */
  issues: Array<{ rule: string; length?: number; location?: string; lines?: string }>;
  /** Medium-confidence matches still in the payload (never the value): publishing needs an extra confirmation. */
  suspicious: Array<{ rule: string; length: number; location: string; occurrences: number; lines?: string }>;
  /** Which machine sources supplied known secret values (counts only). */
  knownSources: KnownSourceUse[];
  redactions: number;
  bytes: number;
}

/**
 * A review as the browser holds it. `id` names this exact scan: `publish` uploads only the payload of the review
 * with the id it is given, so what is on screen and what is uploaded cannot drift apart. `target` is where this review
 * was made for, and the only place it can be published to.
 */
export interface ShareSummary extends ShareReview {
  id: string;
  target: ShareTarget;
}

export interface Preflight {
  /** Publishing cannot work at all (e.g. missing R2 credentials). */
  error?: string;
  warnings: string[];
}

/** An index that is still being filled in: `Source.sessions` changes under the browser, and this says when. */
export interface IndexFeed {
  /** Rows read so far and the total; undefined once every session has been read. */
  progress(): { done: number; total: number } | undefined;
  /** Called after `Source.sessions` changed (rows filled in or dropped). Returns the unsubscribe. */
  subscribe(listener: () => void): () => void;
  /** List the sessions again: new ones appear, changed ones are read again, vanished ones go (`subscribe` listeners hear about it). */
  refresh(): void;
  /** Stop reading and persist what has been read. */
  stop(): void;
}

export interface Source {
  /**
   * Newest first. While `index` is set, rows not yet read are placeholders (`pending`) and the array is updated in place,
   * so read it again after each notification instead of holding on to it.
   */
  sessions: SessionSummary[];
  index?: IndexFeed;
  /** Live view of shares.json; updated after a successful publish. */
  shares: SharesFile;
  /** The configured default target: where the publish dialog starts. A switch there is for one publish and never changes this. */
  target: ShareTarget;
  /** Rejects with an `AbortError` once `signal` aborts. */
  view(s: SessionSummary, signal: AbortSignal): Promise<SessionView>;
  /** Rejects with an `AbortError` once `signal` aborts, or e.g. `PromptsUnavailableError` for legacy pi sessions in prompts mode. */
  review(s: SessionSummary, mode: ShareMode, target: ShareTarget, signal: AbortSignal): Promise<ShareSummary>;
  /** Whether `target` can publish at all (missing credentials or settings) and what is wrong with the share before the upload. */
  preflight(target: ShareTarget): Preflight;
  /**
   * Uploads the payload of the review `reviewId` named, to the `target` it was made for, and nothing else: a payload that is
   * gone, was replaced by a newer review or was reviewed for another target is refused. `suspiciousConfirmed`: the user has seen the suspicious values of that payload and chose to publish anyway.
   */
  publish(s: SessionSummary, mode: ShareMode, opts: { reviewId: string; target: ShareTarget; suspiciousConfirmed?: boolean }): Promise<{ url: string; warnings: string[] }>;
  /** The browser is closing: stop all background work. */
  close(): void;
}

/** `publish` was given a review the source no longer holds (evicted, spent, replaced, or made for another target): the caller must review again. */
export class StaleReviewError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StaleReviewError";
  }
}

export const destinationLabel = (target: ShareTarget): string => (target === "gist" ? "a secret (unlisted) gist" : "the public R2 bucket (unlisted id)");

export interface SourceOptions {
  config: OvershareConfig;
  sessions: SessionSummary[];
  /** The job filling `sessions` in, if indexing is still running. */
  index?: IndexFeed;
  target?: ShareTarget;
  /** Keep this many reviewed payloads so the publish sends exactly what was reviewed. */
  keepPrepared?: number;
  /** Publisher factory, injectable for tests. */
  publisher?: (config: OvershareConfig, target: ShareTarget) => Publisher;
  /** Where view and review jobs run; worker threads unless a test says otherwise. */
  runner?: JobRunner;
}

/** A reviewed payload, kept so the publish sends exactly it. */
interface Reviewed {
  summary: ShareSummary;
  /** The scanned bytes, as the worker produced them. */
  payload: Uint8Array;
  session: PublishSession;
}

/** A review that is running; several callers (the viewer's redaction check, the publish dialog) may wait on the same one. */
interface Flight {
  done: Promise<Reviewed>;
  waiters: number;
  abort(): void;
}

export function createSource(opts: SourceOptions): Source {
  const { config, sessions } = opts;
  const defaultTarget = opts.target ?? config.target;
  const shares = loadShares();
  const runner = opts.runner ?? workerRunner();
  const prepared = new Map<string, Reviewed>();
  const flights = new Map<string, Flight>();
  const keep = opts.keepPrepared ?? 4;
  const makePublisher = opts.publisher ?? createPublisher;
  const everything = new AbortController();

  // The target is part of the key: a review made for one destination is never the one uploaded to another.
  const key = (s: SessionSummary, mode: ShareMode, target: ShareTarget) => `${s.path}|${s.mtimeMs}|${s.size}|${mode}|${target}`;

  /** Reject as soon as `signal` aborts, whatever the underlying job is doing. */
  const until = <T>(signal: AbortSignal, work: Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const abort = () => reject(abortError());
      if (signal.aborted) return abort();
      signal.addEventListener("abort", abort, { once: true });
      work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    });

  const start = (s: SessionSummary, mode: ShareMode, target: ShareTarget): Flight => {
    const k = key(s, mode, target);
    const ctl = new AbortController();
    const flight: Flight = {
      waiters: 0,
      abort: () => ctl.abort(),
      done: runner.run({ kind: "review", path: s.path, harness: s.harness, mode, config }, AbortSignal.any([ctl.signal, everything.signal])).then((result) => {
        if (result.kind !== "review") throw new Error("unexpected job result");
        const entry: Reviewed = { summary: { id: randomUUID(), target, ...result.review }, payload: result.payload, session: result.session };
        prepared.set(k, entry);
        while (prepared.size > keep) prepared.delete(prepared.keys().next().value!);
        return entry;
      }),
    };
    flights.set(k, flight);
    const forget = () => void (flights.get(k) === flight && flights.delete(k));
    flight.done.then(forget, forget);
    return flight;
  };

  return {
    sessions,
    index: opts.index,
    shares,
    target: defaultTarget,
    async view(s, signal) {
      const result = await runner.run({ kind: "view", path: s.path, harness: s.harness }, AbortSignal.any([signal, everything.signal]));
      if (result.kind !== "view") throw new Error("unexpected job result");
      return result.view;
    },
    async review(s, mode, target, signal) {
      // A caller that is already gone must not start (or join) a scan: its abort listener would never fire.
      if (signal.aborted) throw abortError();
      const k = key(s, mode, target);
      const hit = prepared.get(k);
      if (hit) return hit.summary;
      const flight = flights.get(k) ?? start(s, mode, target);
      flight.waiters++;
      // The scan stops once nobody is waiting for it any more, and is forgotten at once so that a retry made
      // right away starts a fresh scan instead of joining the cancelled one.
      const release = () => {
        if (--flight.waiters > 0) return;
        flight.abort();
        if (flights.get(k) === flight) flights.delete(k);
      };
      signal.addEventListener("abort", release, { once: true });
      try {
        return (await until(signal, flight.done)).summary;
      } finally {
        signal.removeEventListener("abort", release);
      }
    },
    preflight(target) {
      const warnings = preflightWarnings(config, target);
      try {
        makePublisher(config, target);
        return { warnings };
      } catch (err) {
        return { error: (err as Error).message, warnings };
      }
    },
    async publish(s, mode, opts) {
      // Only ever upload the payload of the review the user was shown. If it has been evicted or replaced, re-preparing
      // here would upload content nobody looked at, so make the user review again.
      const { target } = opts;
      const share = prepared.get(key(s, mode, target));
      if (!share || share.summary.id !== opts.reviewId) throw new StaleReviewError("The reviewed payload is no longer available; go back and review it again before publishing.");
      if (share.summary.blocked) throw new Error("Refusing to publish: the final re-scan found unredacted secrets.");
      if (share.summary.suspicious.length && !opts.suspiciousConfirmed) throw new Error("Refusing to publish: suspicious values are still in the payload and were not confirmed.");
      const json = new TextDecoder("utf-8", { fatal: true }).decode(share.payload);
      if (Buffer.byteLength(json) !== share.summary.bytes) throw new StaleReviewError("The reviewed payload does not match its review; go back and review it again before publishing.");
      const publisher = makePublisher(config, target);
      const { result, warnings } = await publishPrepared(publisher, config, target, { json, session: share.session });
      prepared.delete(key(s, mode, target));
      // Mirror shares.json in memory so the list marks it as shared right away.
      const fresh = loadShares();
      for (const k of Object.keys(shares)) delete shares[k];
      Object.assign(shares, fresh);
      const k = shareKey(s.harness, s.id);
      if (!(shares[k] ?? []).some((r) => r.url === result.viewerUrl)) (shares[k] ??= []).push({ url: result.viewerUrl, mode, target, sharedAt: new Date().toISOString() });
      return { url: result.viewerUrl, warnings };
    },
    close() {
      everything.abort();
      runner.close();
    },
  };
}
