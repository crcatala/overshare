/**
 * Opening a session and scanning it run in the background. These tests hold a view or a review "in flight" with a
 * deferred promise and check the races: a result that arrives after the user moved on must not be shown or published,
 * and the confirm step must never be reachable for a payload that is not the one on screen.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ShareReview, SessionView } from "../src/browse/source.js";
import type { ShareMode } from "../src/schema.js";
import { deferred, drive as baseDrive, KEY, sampleView, type FakeSourceOptions } from "./browse-helpers.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const review = (mode: ShareMode, bytes: number, over: Partial<ShareReview> = {}): ShareReview => ({ mode, clean: true, blocked: false, findings: [], issues: [], suspicious: [], knownSources: [], redactions: 0, bytes, ...over });
const viewTitled = (text: string): SessionView => ({ ...sampleView(), items: [{ kind: "user", turn: 1, label: text, body: text }, { kind: "assistant", turn: 1, label: `reply to ${text}`, body: `reply to ${text}` }] });

/** A fake source whose reviews are held until the test resolves them, one deferred per call, in call order. */
function heldReviews() {
  const held: Array<{ mode: ShareMode; d: ReturnType<typeof deferred<ShareReview>> }> = [];
  return {
    held,
    review: (_: unknown, mode: ShareMode) => {
      const d = deferred<ShareReview>();
      held.push({ mode, d });
      return d.promise;
    },
    last: (mode: ShareMode) => held.filter((h) => h.mode === mode).at(-1)!,
  };
}

/**
 * Every test runs twice: against a source that rejects at once when aborted (like the real one), and against one that
 * ignores the abort and delivers its answer late anyway. The browser must drop the stale answer itself in both.
 */
let ignoreAbort = false;
const drive = (opts: FakeSourceOptions = {}) => baseDrive({ ...opts, ignoreAbort });

describe.each([false, true])("source that ignores the abort: %s", (ignore) => {
  beforeEach(() => void (ignoreAbort = ignore));

  describe("opening a session", () => {
    it("shows a loading state at once, keeps drawing it, and fills in when the read finishes", async () => {
      const v = deferred<SessionView>();
      const h = heldReviews();
      const d = drive({ view: () => v.promise, review: h.review });
      await d.press(KEY.enter);
      expect(d.text()).toContain("reading the session…");
      expect(d.text()).toContain("esc to cancel");
      // Redraws keep coming while it waits: the spinner moves.
      const frames = new Set<string>();
      for (let i = 0; i < 5; i++) {
        frames.add(d.text().match(/([⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]) reading the session/)![1]!);
        await vi.advanceTimersByTimeAsync(100);
      }
      expect(frames.size).toBeGreaterThan(1);
      v.resolve(sampleView());
      await vi.advanceTimersByTimeAsync(0);
      expect(d.text()).toContain("fix the bug in the invoice handler");
      expect(d.text()).not.toContain("reading the session…");
      expect(d.text()).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] checking redaction…/); // the second read is still running
      h.last("brief").d.resolve(review("brief", 12_345));
      await vi.advanceTimersByTimeAsync(0);
      expect(d.text()).toContain("✓ brief share is clean");
    });

    it("handles keys while it loads: esc cancels both reads and goes back to the list", async () => {
      const d = drive({ view: () => new Promise<SessionView>(() => {}), review: () => new Promise<ShareReview>(() => {}) });
      await d.press(KEY.enter);
      await d.press("j", "k", "v", KEY.down); // nothing to move in yet; none of this may throw or change the screen
      expect(d.app.viewer).toBeDefined();
      expect(d.app.lastError).toBeUndefined();
      const [view] = d.source.viewed;
      expect(view!.signal.aborted).toBe(false);
      await d.press(KEY.esc);
      expect(d.app.viewer).toBeUndefined();
      expect(view!.signal.aborted).toBe(true);
      expect(d.source.reviewSignals.every((s) => s.aborted)).toBe(true);
      expect(d.text()).toContain("agent-share");
    });

    it("drops a result that arrives after the viewer was closed, and never shows it in the next session", async () => {
      const first = deferred<SessionView>();
      let calls = 0;
      const second = deferred<SessionView>();
      const d = drive({ view: () => (++calls === 1 ? first.promise : second.promise) });
      await d.press(KEY.enter); // session s1, still loading
      await d.press(KEY.esc); // give up
      await d.press("j", KEY.enter); // open s2
      expect(d.app.viewer!.session.id).toBe("s2");
      first.resolve(viewTitled("OLD SESSION PROMPT")); // the first read finishes late
      await vi.advanceTimersByTimeAsync(0);
      expect(d.text()).toContain("reading the session…");
      expect(d.text()).not.toContain("OLD SESSION PROMPT");
      second.resolve(viewTitled("NEW SESSION PROMPT"));
      await vi.advanceTimersByTimeAsync(0);
      expect(d.text()).toContain("NEW SESSION PROMPT");
      expect(d.text()).not.toContain("OLD SESSION PROMPT");
    });

    it("drops a late failure the same way", async () => {
      const first = deferred<SessionView>();
      const d = drive({ view: () => first.promise });
      await d.press(KEY.enter, KEY.esc);
      first.reject(new Error("late failure"));
      await vi.advanceTimersByTimeAsync(0);
      expect(d.app.viewer).toBeUndefined();
      expect(d.text()).not.toContain("late failure");
      expect(d.app.lastError).toBeUndefined();
    });

    it("shows a read failure in place of the session, and a failed redaction check without hiding the session", async () => {
      const unreadable = drive({ view: () => Promise.reject(new Error("could not read the session file (ENOENT)")) });
      await unreadable.press(KEY.enter);
      expect(unreadable.text()).toContain("could not read this session: could not read the session file (ENOENT)");
      const unchecked = drive({ review: () => Promise.reject(new Error("internal error in the background reader (TypeError)")) });
      await unchecked.press(KEY.enter);
      expect(unchecked.text()).toContain("redaction check unavailable: internal error in the background reader (TypeError)");
      expect(unchecked.text()).toContain("$1.20");
    });

    it("quitting while a session loads stops every read", async () => {
      const d = drive({ view: () => new Promise<SessionView>(() => {}), review: () => new Promise<ShareReview>(() => {}) });
      let quit = false;
      d.app.onQuit = () => void (quit = true);
      await d.press(KEY.enter); // loading
      d.app.quit();
      expect(quit).toBe(true);
      expect(d.source.closed).toBe(true);
      expect(d.source.viewed.every((v) => v.signal.aborted)).toBe(true);
      expect(d.source.reviewSignals.every((s) => s.aborted)).toBe(true);
    });

    it("quitting from the list after leaving a loading viewer also closes the source", async () => {
      const d = drive({ view: () => new Promise<SessionView>(() => {}) });
      await d.press(KEY.enter, KEY.esc, "q", "y");
      expect(d.source.closed).toBe(true);
    });
  });

  describe("publish dialog", () => {
    it("shows the scan as running and cannot continue until the review of the shown mode has arrived", async () => {
      const h = heldReviews();
      const d = drive({ review: h.review });
      await d.press("p");
      expect(d.text()).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] scanning for secrets…/);
      await d.press(KEY.enter, "y", "c"); // nothing to continue with yet
      expect(d.text()).toContain("scanning for secrets…");
      expect(d.text()).not.toContain("Publish brief to");
      expect(d.source.published).toEqual([]);
      h.last("brief").d.resolve(review("brief", 5_000));
      await vi.advanceTimersByTimeAsync(0);
      expect(d.text()).toContain("4.9 KB payload");
      await d.press(KEY.enter);
      expect(d.text()).toContain("Publish brief to");
    });

    it("switching mode mid-review aborts the old scan, ignores its late result, and publishes only the mode on screen", async () => {
      const h = heldReviews();
      const d = drive({ review: h.review });
      await d.press("p"); // brief in flight
      const brief = h.last("brief");
      await d.press("1"); // full
      expect(d.source.reviewSignals[0]!.aborted).toBe(true);
      brief.d.resolve(review("brief", 111_111)); // the superseded scan finishes anyway
      await vi.advanceTimersByTimeAsync(0);
      expect(d.text()).not.toContain("108.5 KB");
      expect(d.text()).toContain("scanning for secrets…");
      await d.press(KEY.enter, "y");
      expect(d.source.published).toEqual([]);
      h.last("full").d.resolve(review("full", 2_000_000));
      await vi.advanceTimersByTimeAsync(0);
      expect(d.text()).toContain("1.9 MB payload");
      await d.press(KEY.enter);
      expect(d.text()).toContain("Publish full to");
      await d.press("y");
      expect(d.source.published).toEqual([{ id: "s1", mode: "full" }]);
      expect(d.source.publishedReviewIds).toEqual(["review-2"]); // the full review, not the brief one
    });

    it("going back to a mode whose scan was cancelled scans it again", async () => {
      const h = heldReviews();
      const d = drive({ review: h.review });
      await d.press("p"); // brief starts after the debounce
      d.app.handleInput("1"); // full: brief is cancelled …
      await vi.advanceTimersByTimeAsync(10);
      d.app.handleInput("2"); // … and brief again before full's debounce ran: only brief is scanned, anew
      await vi.advanceTimersByTimeAsync(300);
      expect(h.held.map((x) => x.mode)).toEqual(["brief", "brief"]);
      expect(d.source.reviewSignals.map((s) => s.aborted)).toEqual([true, false]);
      h.held[0]!.d.resolve(review("brief", 111_111)); // the cancelled one cannot answer for the new one
      await vi.advanceTimersByTimeAsync(0);
      expect(d.text()).toContain("scanning for secrets…");
      h.held[1]!.d.resolve(review("brief", 5_000));
      await vi.advanceTimersByTimeAsync(0);
      expect(d.text()).toContain("4.9 KB payload");
    });

    it("closing the dialog mid-review aborts the scan, and its late result neither shows nor publishes", async () => {
      const h = heldReviews();
      const d = drive({ review: h.review });
      await d.press("p");
      const [signal] = d.source.reviewSignals;
      await d.press(KEY.esc);
      expect(d.app.flow).toBeUndefined();
      expect(signal!.aborted).toBe(true);
      h.last("brief").d.resolve(review("brief", 5_000));
      await vi.advanceTimersByTimeAsync(0);
      expect(d.app.lastError).toBeUndefined();
      await d.press("p"); // a fresh dialog scans again; it does not inherit the old result
      expect(d.text()).toContain("scanning for secrets…");
      expect(h.held).toHaveLength(2);
      await d.press(KEY.enter, "y");
      expect(d.source.published).toEqual([]);
    });

    it("a scan that fails after the dialog closed is ignored", async () => {
      const h = heldReviews();
      const d = drive({ review: h.review });
      await d.press("p", KEY.esc);
      h.last("brief").d.reject(new Error("late failure"));
      await vi.advanceTimersByTimeAsync(0);
      expect(d.app.lastError).toBeUndefined();
      expect(d.text()).not.toContain("late failure");
    });

    it("quitting with the dialog open stops the scan", async () => {
      const h = heldReviews();
      const d = drive({ review: h.review });
      await d.press("p");
      d.app.quit();
      expect(d.source.reviewSignals.every((s) => s.aborted)).toBe(true);
      expect(d.source.closed).toBe(true);
    });

    it("a double press of y uploads once", async () => {
      const up = deferred<{ url: string; warnings: string[] }>();
      const d = drive({ publish: () => up.promise });
      await d.press("p", KEY.enter);
      d.app.handleInput("y");
      d.app.handleInput("y");
      d.app.handleInput("Y");
      d.app.handleInput(KEY.enter);
      await vi.advanceTimersByTimeAsync(0);
      expect(d.source.published).toEqual([{ id: "s1", mode: "brief" }]);
      expect(d.text()).toContain("publishing…");
      await d.press(KEY.esc, "n"); // cannot back out of an upload in progress
      expect(d.app.flow).toBeDefined();
      up.resolve({ url: "https://viewer.example/#s1", warnings: [] });
      await vi.advanceTimersByTimeAsync(0);
      expect(d.source.published).toHaveLength(1);
      expect(d.text()).toContain("✓ published");
    });

    it("publishes the review id it showed; a payload that was replaced since is refused, and nothing is marked shared", async () => {
      const d = drive();
      await d.press("p", KEY.enter); // confirm step for review-1 of brief
      // Another review of the same session and mode replaces the payload the user confirmed.
      await d.source.review(d.app.flow!.session, "brief", new AbortController().signal);
      await d.press("y");
      expect(d.source.publishedReviewIds).toEqual(["review-1"]);
      expect(d.source.published).toEqual([]);
      expect(d.text()).toContain("publishing failed");
      expect(d.text().replace(/[│\s]+/g, " ")).toContain("review it again");
      expect(d.text()).not.toContain("✓ published");
    });

    it("keeps the suspicious-values step in front of the confirm step with a review that arrives late", async () => {
      const h = heldReviews();
      const d = drive({ review: h.review });
      await d.press("p", KEY.enter, "c", "y"); // all before the review exists
      expect(d.source.published).toEqual([]);
      h.last("brief").d.resolve(review("brief", 5_000, { clean: false, issues: [], suspicious: [{ rule: "secret-assignment", length: 16, location: "turn 3 · Bash · input (object key)", occurrences: 1 }] }));
      await vi.advanceTimersByTimeAsync(0);
      await d.press(KEY.enter, "y", KEY.enter); // continue → suspicious step; y and enter do not pass it
      expect(d.text()).toContain("continue anyway");
      expect(d.source.published).toEqual([]);
      await d.press("c", "y");
      expect(d.source.published).toEqual([{ id: "s1", mode: "brief" }]);
      expect(d.source.suspiciousConfirmed).toEqual([true]);
    });

    it("a blocked review that arrives late still cannot continue", async () => {
      const h = heldReviews();
      const d = drive({ review: h.review });
      await d.press("p");
      h.last("brief").d.resolve(review("brief", 5_000, { clean: false, blocked: true }));
      await vi.advanceTimersByTimeAsync(0);
      await d.press(KEY.enter, "y");
      expect(d.text()).toContain("✗ blocked");
      expect(d.source.published).toEqual([]);
    });

    it("from the viewer, the dialog and the viewer's own redaction check do not interfere", async () => {
      const h = heldReviews();
      const d = drive({ review: h.review });
      await d.press(KEY.enter, "p"); // viewer (brief check in flight), then the dialog (brief scan after the debounce)
      expect(h.held.map((x) => x.mode)).toEqual(["brief", "brief"]);
      await d.press(KEY.esc); // close the dialog: only its own scan is cancelled
      expect(d.source.reviewSignals.map((s) => s.aborted)).toEqual([false, true]);
      h.held[0]!.d.resolve(review("brief", 5_000));
      await vi.advanceTimersByTimeAsync(0);
      expect(d.text()).toContain("✓ brief share is clean");
    });
  });
});
