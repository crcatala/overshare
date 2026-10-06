import { describe, expect, it } from "vitest";
import { ago, dayBucket, durationMs, sessionDuration, toolSummary } from "../src/browse/display.js";
import { composite, emergencyRestore, isPlain, isShift, padLines, plainText, Screen, typedText, w } from "../src/browse/kit.js";

class Boom extends Screen {
  constructor(private failing: { key?: boolean; draw?: boolean }) {
    super();
  }
  draw(): string[] {
    if (this.failing.draw) throw new Error("draw failed");
    return ["ok"];
  }
  onKey(): void {
    if (this.failing.key) throw new TypeError("key failed");
  }
}

describe("Screen error containment", () => {
  it("keeps a throwing key handler from crashing the TUI, and clears the error on the next key", () => {
    const s = new Boom({ key: true });
    expect(() => s.handleInput("x")).not.toThrow();
    expect(s.lastError).toBe("TypeError: key failed");
    s.handleInput("y"); // still failing, but the error is for this key
    expect(s.lastError).toBe("TypeError: key failed");
    const ok = new Boom({});
    ok.lastError = "stale";
    ok.handleInput("x");
    expect(ok.lastError).toBeUndefined();
  });

  it("replaces a throwing draw with a readable error screen at the right size", () => {
    const s = new Boom({ draw: true });
    s.attach(() => 10, () => {});
    const lines = s.render(50);
    expect(plainText(lines[0]!)).toBe("render error: Error: draw failed");
    expect(lines.length).toBeLessThanOrEqual(10);
    expect(Math.max(...lines.map(w))).toBeLessThanOrEqual(50);
  });
});

describe("emergencyRestore", () => {
  const capture = (isTTY: boolean) => {
    const written: string[] = [];
    emergencyRestore({ isTTY, write: (s) => written.push(s) });
    return written.join("");
  };

  it("undoes the modes pi-tui turns on, so a crash cannot leave the shell printing raw key codes", () => {
    const out = capture(true);
    expect(out).toContain("\x1b[<u"); // Kitty keyboard protocol popped (this is what made ctrl+r print CSI-u codes)
    expect(out).toContain("\x1b[>4;0m"); // modifyOtherKeys off
    expect(out).toContain("\x1b[?2004l"); // bracketed paste off
    expect(out).toContain("\x1b[?1000l"); // mouse tracking off
    expect(out).toContain("\x1b[?25h"); // cursor visible
    // The alternate screen is left last, so the restored shell is on the normal screen.
    expect(out.lastIndexOf("\x1b[?1049l")).toBeGreaterThan(out.lastIndexOf("\x1b[?25h"));
  });

  it("writes nothing when output is not a terminal", () => {
    expect(capture(false)).toBe("");
  });

  it("never throws, even when the terminal is gone", () => {
    expect(() =>
      emergencyRestore({
        isTTY: true,
        write: () => {
          throw new Error("EPIPE");
        },
      }),
    ).not.toThrow();
  });
});

describe("key helpers", () => {
  it("tell a plain letter from Shift+letter in both legacy and Kitty encodings", () => {
    expect(isPlain("r", "r")).toBe(true);
    expect(isShift("r", "r")).toBe(false);
    expect(isPlain("R", "r")).toBe(false);
    expect(isShift("R", "r")).toBe(true);
    expect(isShift("\x1b[114;2u", "r")).toBe(true); // Kitty: Shift+r
    expect(isPlain("\x1b[114;2u", "r")).toBe(false);
  });

  it("typedText keeps printable keys and a bracketed paste on one line, and nothing else", () => {
    expect(typedText("a")).toBe("a");
    expect(typedText("\x1b[A")).toBeUndefined(); // up arrow
    expect(typedText("\r")).toBeUndefined();
    expect(typedText("\x1b[200~fix invoice\x1b[201~")).toBe("fix invoice");
    expect(typedText("\x1b[200~two\r\nlines\tand\x1b[31mred\x07\n\x1b[201~")).toBe("two lines andred");
  });
});

describe("composite", () => {
  it("centres an overlay and never changes the line count or overflows the width", () => {
    const base = Array.from({ length: 9 }, (_, i) => `row ${i} ${"x".repeat(60)}`);
    const out = composite(base, ["┌────┐", "│ hi │", "└────┘"], 40);
    expect(out).toHaveLength(9);
    expect(out.every((l) => w(l) <= 40)).toBe(true);
    expect(out.map(plainText).filter((l) => l.includes("│ hi │"))).toHaveLength(1);
  });
});

describe("display helpers", () => {
  const now = Date.UTC(2026, 8, 30, 12);
  it("ago uses relative words near now and dates far away", () => {
    expect(ago(now - 30_000, now)).toBe("just now");
    expect(ago(now - 5 * 3_600_000, now)).toBe("5h ago");
    expect(ago(now - 86_400_000, now)).toBe("yesterday");
    expect(ago(now - 3 * 86_400_000, now)).toBe("3d ago");
    expect(ago(now - 3 * 7 * 86_400_000, now)).toBe("3w ago");
    expect(ago(now - 200 * 86_400_000, now)).toMatch(/^[A-Z][a-z]{2} \d{1,2}$/);
  });

  it("dayBucket groups by calendar day, not by 24-hour windows", () => {
    process.env.TZ = "UTC";
    expect(dayBucket(Date.UTC(2026, 8, 30, 0, 5), now)).toBe("Today");
    expect(dayBucket(Date.UTC(2026, 8, 29, 23, 55), now)).toBe("Yesterday"); // 12 h ago, but yesterday
    expect(dayBucket(Date.UTC(2026, 8, 26), now)).toBe("This week");
    expect(dayBucket(Date.UTC(2026, 8, 10), now)).toBe("This month");
    expect(dayBucket(Date.UTC(2026, 6, 1), now)).toBe("Older");
  });

  it("formats durations and tool summaries defensively", () => {
    expect(sessionDuration({ startedAt: "2026-01-01T00:00:00Z", endedAt: "2026-01-01T01:30:00Z" })).toBe("1h 30m");
    expect(sessionDuration({ startedAt: undefined, endedAt: undefined })).toBeUndefined();
    expect(durationMs({ startedAt: "2026-01-02T00:00:00Z", endedAt: "2026-01-01T00:00:00Z" })).toBe(0); // clock went backwards
    expect(toolSummary({ Bash: 2, Read: 9, Edit: 1 }, 2)).toBe("Read ×9 · Bash ×2");
  });

  it("padLines pads up to, never past, the requested height", () => {
    expect(padLines(["a"], 3)).toEqual(["a", "", ""]);
    expect(padLines(["a", "b", "c"], 2)).toEqual(["a", "b", "c"]);
  });
});
