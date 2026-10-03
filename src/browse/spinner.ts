/**
 * A spinner glyph that advances on a timer while something loads, so a waiting screen visibly stays alive
 * (and a frozen event loop would visibly freeze it). The timer is `unref`ed and stops with `stop()`.
 */
const FRAMES = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";

export class Spinner {
  private n = 0;
  private timer?: ReturnType<typeof setInterval>;

  get frame(): string {
    return FRAMES[this.n % FRAMES.length]!;
  }

  start(redraw: () => void, everyMs = 100): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.n++;
      redraw();
    }, everyMs);
    this.timer.unref?.();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }
}
