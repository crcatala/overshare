/**
 * Publish flow state machine: mode → review/confirm → publishing → done (or error). Renderer-agnostic.
 *
 * A payload that still holds suspicious values gets one more step ("suspicious") before the final confirm: the
 * user sees where to look in the transcript and must press `c` to go on; the confirmation is passed to `publish`.
 *
 * Reviews are the real pipeline's (redaction + final re-scan for that mode), run in the background, and are what
 * gets uploaded: `Source.publish` reuses the reviewed payload, named by the review's id. A review that arrives
 * for a mode the user has left, or after the dialog closed, is dropped (each request has its own abort signal),
 * and the confirm step cannot be reached until the review of the mode on screen has arrived. A mode the pipeline
 * refuses (e.g. prompts mode on a legacy pi session) is reported on that mode only; it never crashes the flow.
 *
 * The target (gist or R2) starts at the configured default and `t` cycles it for this publish only. A review belongs to
 * a (mode, target) pair, so a switch drops the scan on screen and shows (or starts) the one for the new target; the
 * upload goes to the target of the review it sends. A target that cannot publish says what is missing and stays blocked.
 */
import { stripControls } from "../sanitize.js";
import { SHARE_TARGETS, type ShareTarget } from "../config.js";
import type { ShareMode } from "../schema.js";
import { SHARE_MODES } from "../schema.js";
import { StaleReviewError, type Preflight, type ShareSummary, type Source } from "./source.js";
import type { SessionSummary } from "../sessions/summary.js";
import { sharesFor } from "../sessions/shares.js";
import { Spinner } from "./spinner.js";

export type FlowStep = "mode" | "suspicious" | "confirm" | "busy" | "done" | "error";

export const MODE_HINT: Record<ShareMode, string> = {
  full: "everything, after redaction",
  brief: "prompts + replies, tool calls collapsed",
  minimal: "prompts + final reply per turn",
  prompts: "only what you typed",
};

/** Delay before scanning a newly chosen mode, so holding j/k through the list does not queue a scan per key. */
const SCAN_DEBOUNCE_MS = 120;

export class PublishFlow {
  step: FlowStep = "mode";
  modeIdx = SHARE_MODES.indexOf("brief");
  loading = false;
  url?: string;
  /** Post-upload warnings (e.g. R2 public access), or the reason an upload failed. */
  warnings: string[] = [];
  failure?: string;
  /** The user passed the suspicious-values step for the current mode. */
  private suspiciousConfirmed = false;
  /** Where this publish goes: the configured default until `cycleTarget` changes it. Never written back to the config. */
  target: ShareTarget;
  /** What each target needs, read once when the dialog opens. */
  private preflights = new Map<ShareTarget, Preflight>();
  private reviews = new Map<string, ShareSummary>();
  /** A (mode, target) the pipeline refused. */
  private refused = new Map<string, string>();
  private timer?: ReturnType<typeof setTimeout>;
  /** The request whose answer is wanted: aborted when the mode changes or the flow closes. */
  private inflight?: AbortController;
  private spinner = new Spinner();

  constructor(
    private source: Source,
    readonly session: SessionSummary,
    private redraw: () => void,
    /** Called when the flow is finished or cancelled. */
    readonly onClose: () => void,
  ) {
    this.target = source.target;
    for (const t of SHARE_TARGETS) this.preflights.set(t, source.preflight(t));
    this.scan();
  }

  /** Frame of the "scanning…" spinner. */
  get spinnerFrame(): string {
    return this.spinner.frame;
  }

  get mode(): ShareMode {
    return SHARE_MODES[this.modeIdx]!;
  }
  /** What the target in play needs: an `error` blocks the publish, `warnings` are shown. */
  get preflight(): Preflight {
    return this.preflightOf(this.target);
  }
  preflightOf(target: ShareTarget): Preflight {
    return this.preflights.get(target)!;
  }
  private slot(mode: ShareMode = this.mode, target: ShareTarget = this.target): string {
    return `${target}:${mode}`;
  }
  get review(): ShareSummary | undefined {
    return this.reviews.get(this.slot());
  }
  /** Why this mode cannot be published, if the pipeline refused it. */
  get refusal(): string | undefined {
    return this.refused.get(this.slot());
  }
  get alreadyShared(): boolean {
    return sharesFor(this.source.shares, this.session.harness, this.session.id).length > 0;
  }
  /** Nothing stops the user from continuing with this mode (a refused mode never has a review). */
  get canContinue(): boolean {
    return !!this.review && !this.review.blocked && !this.preflight.error;
  }

  private scan(): void {
    const { mode, target } = this;
    const slot = this.slot();
    // Whatever was being scanned for another mode or target is not wanted any more.
    this.inflight?.abort();
    this.inflight = undefined;
    clearTimeout(this.timer);
    // A target that cannot publish shows what it lacks instead of a scan nobody can use.
    if (this.reviews.has(slot) || this.refused.has(slot) || this.preflight.error) {
      this.loading = false;
      this.spinner.stop();
      return;
    }
    this.loading = true;
    this.spinner.start(this.redraw);
    this.timer = setTimeout(() => this.request(mode, target), SCAN_DEBOUNCE_MS);
    this.redraw();
  }

  private request(mode: ShareMode, target: ShareTarget): void {
    const slot = this.slot(mode, target);
    const ctl = new AbortController();
    this.inflight = ctl;
    // An answer counts only while its request is still the current one.
    const arrive = (record: () => void) => {
      if (ctl.signal.aborted || this.inflight !== ctl) return;
      this.inflight = undefined;
      record();
      this.loading = false;
      this.spinner.stop();
      this.redraw();
    };
    this.source.review(this.session, mode, target, ctl.signal).then(
      (review) => arrive(() => this.reviews.set(slot, review)),
      (err: unknown) => arrive(() => this.refused.set(slot, stripControls(err instanceof Error ? err.message : String(err)))),
    );
  }

  setMode(i: number): void {
    if (this.step !== "mode" || i < 0 || i >= SHARE_MODES.length) return;
    this.modeIdx = i;
    this.scan();
  }
  moveMode(delta: number): void {
    this.setMode(Math.max(0, Math.min(SHARE_MODES.length - 1, this.modeIdx + delta)));
  }
  /** Publish somewhere else this time: the next target, wrapping. What was reviewed for the old one is not what would be uploaded to the new one. */
  cycleTarget(): void {
    if (this.step !== "mode") return;
    this.target = SHARE_TARGETS[(SHARE_TARGETS.indexOf(this.target) + 1) % SHARE_TARGETS.length]!;
    this.scan();
  }

  /** Whether this mode's payload holds suspicious values, which need their own confirmation. */
  get hasSuspicious(): boolean {
    return (this.review?.suspicious.length ?? 0) > 0;
  }

  /**
   * Enter advances the mode step; at the suspicious step only `c` and at the confirm step only `y` call this
   * (see `BrowserApp.flowKey`).
   */
  next(): void {
    if (this.step === "mode") {
      if (this.canContinue) {
        this.suspiciousConfirmed = false;
        this.step = this.hasSuspicious ? "suspicious" : "confirm";
      }
    } else if (this.step === "suspicious") {
      this.suspiciousConfirmed = true;
      this.step = "confirm";
    } else if (this.step === "confirm") {
      // Only the review on screen can be published; without one there is nothing to confirm.
      const review = this.review;
      if (!review) return;
      this.step = "busy";
      const slot = this.slot();
      this.source.publish(this.session, this.mode, { reviewId: review.id, target: review.target, suspiciousConfirmed: this.suspiciousConfirmed }).then(
        ({ url, warnings }) => {
          this.url = url;
          this.warnings = warnings;
          this.step = "done";
          this.redraw();
        },
        (err: unknown) => {
          // The source dropped this review (its cache is smaller than every mode x target the user can visit): ours is stale too,
          // and would fail the same way for ever. Forget it, so going back scans again.
          if (err instanceof StaleReviewError) this.reviews.delete(slot);
          this.failure = stripControls(err instanceof Error ? err.message : String(err));
          this.step = "error";
          this.redraw();
        },
      );
    } else if (this.step === "done") {
      this.onClose();
    } else if (this.step === "error") {
      this.step = "mode";
      this.scan();
    }
    this.redraw();
  }

  back(): void {
    if (this.step === "confirm" || this.step === "suspicious") {
      this.suspiciousConfirmed = false;
      this.step = "mode";
    } else if (this.step !== "busy") this.onClose();
    this.redraw();
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.inflight?.abort();
    this.inflight = undefined;
    this.spinner.stop();
  }
}

/** Write text to the system clipboard through the terminal (OSC 52); most modern terminals allow it. */
export function copyToClipboard(text: string, out: { write(s: string): unknown } = process.stdout): void {
  out.write(`\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`);
}
