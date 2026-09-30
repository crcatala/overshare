/**
 * Publish flow state machine: mode → review/confirm → publishing → done (or error). Renderer-agnostic.
 *
 * Reviews are the real pipeline's (redaction + final re-scan for that mode) and are what gets uploaded:
 * `Source.publish` reuses the reviewed payload. A mode the pipeline refuses (e.g. prompts mode on a legacy pi
 * session) is reported on that mode only; it never crashes the flow.
 */
import type { ShareMode } from "../schema.js";
import { SHARE_MODES } from "../schema.js";
import type { Preflight, ShareSummary, Source } from "./source.js";
import type { SessionSummary } from "../sessions/summary.js";
import { sharesFor } from "../sessions/shares.js";

export type FlowStep = "mode" | "confirm" | "busy" | "done" | "error";

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
  readonly preflight: Preflight;
  private reviews = new Map<ShareMode, ShareSummary>();
  /** A mode the pipeline refused, by mode. */
  private refused = new Map<ShareMode, string>();
  private timer?: ReturnType<typeof setTimeout>;

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
    if (this.reviews.has(mode) || this.refused.has(mode)) {
      this.loading = false;
      return;
    }
    this.loading = true;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      try {
        this.reviews.set(mode, this.source.review(this.session, mode));
      } catch (err) {
        this.refused.set(mode, err instanceof Error ? err.message : String(err));
      }
      this.loading = false;
      this.redraw();
    }, SCAN_DEBOUNCE_MS);
    this.redraw();
  }

  setMode(i: number): void {
    if (this.step !== "mode" || i < 0 || i >= SHARE_MODES.length) return;
    this.modeIdx = i;
    this.scan();
  }
  moveMode(delta: number): void {
    this.setMode(Math.max(0, Math.min(SHARE_MODES.length - 1, this.modeIdx + delta)));
  }

  /** Enter / y: advance. */
  next(): void {
    if (this.step === "mode") {
      if (this.canContinue) this.step = "confirm";
    } else if (this.step === "confirm") {
      this.step = "busy";
      const mode = this.mode;
      this.source.publish(this.session, mode).then(
        ({ url, warnings }) => {
          this.url = url;
          this.warnings = warnings;
          this.step = "done";
          this.redraw();
        },
        (err: unknown) => {
          this.failure = err instanceof Error ? err.message : String(err);
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
    if (this.step === "confirm") this.step = "mode";
    else if (this.step !== "busy") this.onClose();
    this.redraw();
  }

  dispose(): void {
    clearTimeout(this.timer);
  }
}

/** Write text to the system clipboard through the terminal (OSC 52); most modern terminals allow it. */
export function copyToClipboard(text: string, out: { write(s: string): unknown } = process.stdout): void {
  out.write(`\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`);
}
