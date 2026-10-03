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
 */
import { stripControls } from "../sanitize.js";
import type { ShareMode } from "../schema.js";
import { SHARE_MODES } from "../schema.js";
import type { Preflight, ShareSummary, Source } from "./source.js";
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
  readonly preflight: Preflight;
  private reviews = new Map<ShareMode, ShareSummary>();
  /** A mode the pipeline refused, by mode. */
  private refused = new Map<ShareMode, string>();
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
    this.preflight = source.preflight();
    this.scan();
  }

  /** Frame of the "scanning…" spinner. */
  get spinnerFrame(): string {
    return this.spinner.frame;
  }

  get mode(): ShareMode {
    return SHARE_MODES[this.modeIdx]!;
  }
  get review(): ShareSummary | undefined {
    return this.reviews.get(this.mode);
  }
  /** Why this mode cannot be published, if the pipeline refused it. */
  get refusal(): string | undefined {
    return this.refused.get(this.mode);
  }
  get alreadyShared(): boolean {
    return sharesFor(this.source.shares, this.session.harness, this.session.id).length > 0;
  }
  /** Nothing stops the user from continuing with this mode (a refused mode never has a review). */
  get canContinue(): boolean {
    return !!this.review && !this.review.blocked && !this.preflight.error;
  }

  private scan(): void {
    const mode = this.mode;
    // Whatever was being scanned for another mode is not wanted any more.
    this.inflight?.abort();
    this.inflight = undefined;
    clearTimeout(this.timer);
    if (this.reviews.has(mode) || this.refused.has(mode)) {
      this.loading = false;
      this.spinner.stop();
      return;
    }
    this.loading = true;
    this.spinner.start(this.redraw);
    this.timer = setTimeout(() => this.request(mode), SCAN_DEBOUNCE_MS);
    this.redraw();
  }

  private request(mode: ShareMode): void {
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
    this.source.review(this.session, mode, ctl.signal).then(
      (review) => arrive(() => this.reviews.set(mode, review)),
      (err: unknown) => arrive(() => this.refused.set(mode, stripControls(err instanceof Error ? err.message : String(err)))),
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
      this.source.publish(this.session, this.mode, { reviewId: review.id, suspiciousConfirmed: this.suspiciousConfirmed }).then(
        ({ url, warnings }) => {
          this.url = url;
          this.warnings = warnings;
          this.step = "done";
          this.redraw();
        },
        (err: unknown) => {
          this.failure = stripControls(err instanceof Error ? err.message : String(err));
          this.step = "error";
          this.redraw();
        },
      );
    } else if (this.step === "done") {
      this.onClose();
    } else if (this.step === "error") {
      this.step = "mode";
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
