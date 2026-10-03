import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { drive, KEY, sampleSessions, type Driver } from "./browse-helpers.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

/**
 * pi-tui throws if a rendered line is wider than the terminal, so every screen must fit at every size:
 * `draw` (before the last-resort truncation in `render`) must already respect the width, and produce exactly `height` lines.
 */
const SIZES: Array<[number, number]> = [[60, 14], [80, 24], [100, 30], [132, 40], [200, 60]];

const STATES: Array<[string, (d: Driver) => Promise<void>]> = [
  ["list", async () => {}],
  ["list grouped by date", async (d) => void (await d.press("g"))],
  ["list grouped by repo, sorted by size", async (d) => void (await d.press("g", "g", "o", "o", "o", "o"))],
  ["search typing", async (d) => void (await d.press("/"))],
  ["repo dialog", async (d) => void (await d.press("R"))],
  ["repo dialog filtering", async (d) => void (await d.press("R", "/"))],
  ["sort dialog", async (d) => void (await d.press("O"))],
  ["help", async (d) => void (await d.press("?"))],
  ["settings dialog", async (d) => void (await d.press(","))],
  ["quit prompt", async (d) => void (await d.press("q"))],
  ["list with a date + time column", async (d) => void (await d.press(",", ...Array(6).fill(KEY.down), KEY.enter))],
  ["viewer (conversation)", async (d) => void (await d.press(KEY.enter))],
  ["viewer (everything)", async (d) => void (await d.press(KEY.enter, "v"))],
  ["viewer content pane focused", async (d) => void (await d.press(KEY.enter, KEY.enter, "j"))],
  ["viewer level dialog", async (d) => void (await d.press(KEY.enter, "V"))],
  ["viewer indented (everything)", async (d) => void (await d.press(KEY.enter, "V", KEY.down, KEY.down, KEY.space, KEY.down, KEY.down, KEY.enter, "v"))],
  ["publish: choose mode", async (d) => void (await d.press("p"))],
  ["publish: confirm", async (d) => void (await d.press("p", KEY.enter))],
  ["publish: done", async (d) => void (await d.press("p", KEY.enter, "y"))],
  ["empty list", async (d) => void (await d.press("/", ..."zzzzqqq"))],
];

describe("every screen fits the terminal", () => {
  for (const [name, setup] of STATES) {
    it(name, async () => {
      const d = drive({ shares: { "claude-code:s1": [{ url: "https://viewer.example/#s1", mode: "brief", target: "gist", sharedAt: new Date().toISOString() }] } });
      await setup(d);
      for (const [width, height] of SIZES) {
        d.app.attach(() => height, () => {});
        const lines = d.app.draw(width, height);
        expect(lines, `${name} @ ${width}x${height}`).toHaveLength(height);
        const tooWide = lines.map((l, i) => ({ i, w: visibleWidth(l) })).filter((l) => l.w > width);
        expect(tooWide, `${name} @ ${width}x${height} has over-wide lines`).toEqual([]);
      }
    });
  }

  describe("while the index is still running (placeholder rows)", () => {
    const ids = sampleSessions().map((x) => x.id);
    const PENDING: Array<[string, (d: Driver) => Promise<void>]> = [
      ["nothing read yet", async () => {}],
      ["half read", async (d) => void ["s1", "s2", "s3", "w1"].forEach((id) => d.source.fill(id))],
      ["searching, partial results", async (d) => void (await d.press("/", ..."invoice"))],
      ["grouped by repo, sorted by title", async (d) => void (await d.press("g", "g", "o", "o"))],
      ["opening a row that is not read", async (d) => void (await d.press(KEY.enter))],
      ["repo picker open while rows arrive", async (d) => void (await d.press("R"), ["s1", "s2", "s3"].forEach((id) => d.source.fill(id)))],
      ["quit prompt", async (d) => void (await d.press("q"))],
      ["empty search", async (d) => void (await d.press("/", ..."zzzzqqq"))],
    ];
    for (const [name, setup] of PENDING) {
      it(name, async () => {
        const d = drive({ pending: ids });
        await setup(d);
        for (const [width, height] of SIZES) {
          d.app.attach(() => height, () => {});
          const lines = d.app.draw(width, height);
          expect(lines, `${name} @ ${width}x${height}`).toHaveLength(height);
          expect(lines.map((l) => visibleWidth(l)).filter((n) => n > width), `${name} @ ${width}x${height} has over-wide lines`).toEqual([]);
        }
      });
    }
  });

  describe("while a session is read or scanned in the background", () => {
    const never = () => new Promise<never>(() => {});
    const LOADING: Array<[string, Parameters<typeof drive>[0], (d: Driver) => Promise<void>]> = [
      ["viewer reading the session", { view: never, review: never }, async (d) => void (await d.press(KEY.enter))],
      ["viewer reading, keys pressed meanwhile", { view: never, review: never }, async (d) => void (await d.press(KEY.enter, "j", "v"))],
      ["viewer waiting for the redaction check", { review: never }, async (d) => void (await d.press(KEY.enter))],
      ["viewer waiting for the check, everything level", { review: never }, async (d) => void (await d.press(KEY.enter, "v"))],
      ["publish dialog scanning", { review: never }, async (d) => void (await d.press("p"))],
      ["publish dialog scanning another mode", { review: never }, async (d) => void (await d.press("p", "1"))],
      ["publish dialog over a loading viewer", { view: never, review: never }, async (d) => void (await d.press(KEY.enter, "p"))],
    ];
    for (const [name, opts, setup] of LOADING) {
      it(name, async () => {
        const d = drive(opts);
        await setup(d);
        for (const [width, height] of SIZES) {
          d.app.attach(() => height, () => {});
          const lines = d.app.draw(width, height);
          expect(lines, `${name} @ ${width}x${height}`).toHaveLength(height);
          expect(lines.map((l) => visibleWidth(l)).filter((n) => n > width), `${name} @ ${width}x${height} has over-wide lines`).toEqual([]);
          const rendered = d.app.render(width);
          expect(rendered, `${name} @ ${width}x${height} render`).toHaveLength(height);
          expect(Math.max(...rendered.map(visibleWidth))).toBeLessThanOrEqual(width);
        }
      });
    }
  });

  it("render never exceeds the width even in a tiny terminal", async () => {
    const d = drive();
    await d.press("p");
    for (const [width, height] of [[20, 6], [30, 8], [44, 10]] as const) {
      d.app.attach(() => height, () => {});
      const lines = d.app.render(width);
      expect(lines).toHaveLength(height);
      expect(Math.max(...lines.map(visibleWidth))).toBeLessThanOrEqual(width);
    }
  });

  it("keeps the selected row visible while scrolling a long list, with and without groups", async () => {
    const many = Array.from({ length: 120 }, (_, i) => ({ ...drive().source.sessions[0]!, id: `m${i}`, path: `/m${i}`, title: `Session number ${String(i).padStart(3, "0")}`, mtimeMs: Date.UTC(2026, 8, 30) - i * 3_600_000 }));
    for (const group of [false, true]) {
      const d = drive({ sessions: many });
      if (group) await d.press("g");
      await d.press(...Array(70).fill("j"));
      const listed = d.lines(120, 20).map((l) => l.split(" │ ")[0]!).join("\n");
      expect(listed).toContain("Session number 070");
      expect(d.lines(120, 20).some((l) => l.includes("▌") && l.includes("Session number 070"))).toBe(true);
      await d.press("\x1b[F"); // End
      expect(d.lines(120, 20).some((l) => l.includes("▌") && l.includes("Session number 119"))).toBe(true);
    }
  });
});
