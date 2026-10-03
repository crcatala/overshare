import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PromptsUnavailableError } from "../src/modes.js";
import { PublishFlow } from "../src/browse/flow.js";
import type { ShareMode } from "../src/schema.js";
import { drive, fakeSource, KEY, sampleSessions } from "./browse-helpers.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const REFUSAL = "Cannot use prompts mode: 12 pi user prompt(s) have no verified pre-expansion input. Private template/skill instructions may be stored as user text.";

describe("publish dialog", () => {
  it("reviews brief by default and publishes exactly the reviewed mode after confirmation", async () => {
    const d = drive();
    await d.press("p");
    expect(d.text()).toContain("✓ clean");
    expect(d.source.reviewed).toEqual([{ id: "s1", mode: "brief" }]);
    await d.press(KEY.enter); // continue → confirm
    expect(d.text()).toContain("Publish brief to a secret (unlisted) gist?");
    expect(d.source.published).toEqual([]); // nothing is sent before the explicit yes
    await d.press("y");
    expect(d.source.published).toEqual([{ id: "s1", mode: "brief" }]);
    expect(d.text()).toContain("✓ published");
    expect(d.text()).toContain("https://viewer.example/#s1");
  });

  it("enter never publishes: only an explicit y does", async () => {
    const d = drive();
    await d.press("p", KEY.enter, KEY.enter, KEY.enter); // continue, then enter at the confirm step, repeatedly
    expect(d.text()).toContain("Publish brief to");
    expect(d.source.published).toEqual([]);
    await d.press(KEY.space, "x", "N"); // other keys do nothing; N goes back
    expect(d.source.published).toEqual([]);
    await d.press(KEY.enter, "Y"); // continue again, then capital Y
    expect(d.source.published).toEqual([{ id: "s1", mode: "brief" }]);
  });

  it("marks the session as shared once publishing is done", async () => {
    const d = drive();
    await d.press("p", KEY.enter, "y", KEY.enter); // … and close
    expect(d.app.flow).toBeUndefined();
    expect(d.text()).toContain("✓ shared");
  });

  it("n and esc cancel without publishing", async () => {
    const d = drive();
    await d.press("p", KEY.enter, "n"); // back to mode selection
    expect(d.text()).toContain("enter continue");
    await d.press(KEY.esc);
    expect(d.app.flow).toBeUndefined();
    expect(d.source.published).toEqual([]);
  });

  it("scans the mode you pick (number keys and j/k) and shows its payload size", async () => {
    const d = drive({ review: (_, mode) => ({ mode, clean: true, blocked: false, findings: [], suspicious: [], knownSources: [], redactions: 0, bytes: { full: 2_000_000, brief: 200_000, minimal: 60_000, prompts: 9_000 }[mode] }) });
    await d.press("p");
    expect(d.text()).toContain("195.3 KB payload");
    await d.press("1");
    expect(d.text()).toContain("1.9 MB payload");
    await d.press("j"); // brief again, already reviewed: no second scan
    expect(d.source.reviewed.filter((r) => r.mode === "brief")).toHaveLength(1);
  });

  it("explains a mode the pipeline refuses, refuses to continue with it, and recovers on another mode", async () => {
    const d = drive({
      review: (_, mode) => {
        if (mode === "prompts") throw new PromptsUnavailableError(REFUSAL);
        return { mode, clean: true, blocked: false, findings: [], suspicious: [], knownSources: [], redactions: 0, bytes: 1000 };
      },
    });
    await d.press("p", "4"); // prompts
    const text = d.text();
    expect(text).toContain("prompts mode is not available for this session");
    expect(text).toContain("12 pi user prompt(s) have no verified pre-expansion input");
    await d.press(KEY.enter); // must not advance
    expect(d.text()).toContain("enter continue");
    expect(d.text()).not.toContain("Publish prompts to");
    await d.press("3", KEY.enter); // minimal works
    expect(d.text()).toContain("Publish minimal to");
  });

  it("never lets a blocked share continue", async () => {
    const d = drive({ review: (_, mode) => ({ mode, clean: false, blocked: true, findings: [], suspicious: [], knownSources: [], redactions: 0, bytes: 1 }) });
    await d.press("p");
    expect(d.text()).toContain("✗ blocked: unredacted secrets remain");
    await d.press(KEY.enter, "y");
    expect(d.source.published).toEqual([]);
    expect(d.text()).not.toContain("Publish brief to");
  });

  it("lists what was redacted and asks for review when findings exist", async () => {
    const d = drive({
      review: (_, mode) => ({ mode, clean: false, blocked: false, findings: [{ rule: "github-token", where: "turn 2 tool input" }, { rule: "email", where: "turn 1 prompt" }], suspicious: [], knownSources: [], redactions: 2, bytes: 5000 }),
    });
    await d.press("p");
    expect(d.text()).toContain("! 2 findings — redacted, please review");
    expect(d.text()).toContain("github-token @ turn 2 tool input");
    await d.press(KEY.enter);
    expect(d.text()).toContain("Publish brief to"); // still requires the explicit y
  });

  describe("suspicious values", () => {
    const suspiciousReview = (_: unknown, mode: ShareMode) => ({
      mode,
      clean: false,
      blocked: false,
      findings: [],
      suspicious: [
        { rule: "secret-assignment", length: 16, location: "turn 3 · Bash · input (object key)", occurrences: 1 },
        { rule: "eightxeight-2", length: 30, location: "turn 7 · Read · input.path", occurrences: 2 },
      ],
      knownSources: [],
      redactions: 0,
      bytes: 5000,
    });

    it("tells the mode step about them, then makes the user pass an extra step before the final confirmation", async () => {
      const d = drive({ review: suspiciousReview });
      await d.press("p");
      expect(d.text()).toContain("2 suspicious values left in the payload");
      expect(d.text()).not.toContain("✓ clean");
      expect(d.text()).not.toContain("0 findings");
      await d.press(KEY.enter); // continue → suspicious step, not the confirm step
      const text = d.text(100, 40).replace(/[│\s]+/g, " ");
      expect(text).toContain("2 suspicious values could not be redacted");
      expect(text).toContain("secret-assignment (16 chars) @ turn 3 · Bash · input (object key)");
      expect(text).toContain("eightxeight-2 (30 chars, ×2) @ turn 7 · Read · input.path");
      expect(text).toContain("/sessions/s1.jsonl");
      expect(text).not.toContain("Publish brief to");
      expect(d.source.published).toEqual([]);
    });

    it("only an explicit c moves on; enter, y and space do not, and nothing is sent before the final y", async () => {
      const d = drive({ review: suspiciousReview });
      await d.press("p", KEY.enter, KEY.enter, "y", KEY.space, "x");
      expect(d.text()).toContain("continue anyway");
      expect(d.source.published).toEqual([]);
      await d.press("c");
      expect(d.text()).toContain("Publish brief to a secret (unlisted) gist?");
      expect(d.source.published).toEqual([]);
      await d.press(KEY.enter, "c");
      expect(d.source.published).toEqual([]);
      await d.press("y");
      expect(d.source.published).toEqual([{ id: "s1", mode: "brief" }]);
      expect(d.source.suspiciousConfirmed).toEqual([true]);
    });

    it("n and esc leave without publishing, and coming back asks again", async () => {
      const d = drive({ review: suspiciousReview });
      await d.press("p", KEY.enter, "n");
      expect(d.text()).toContain("enter continue");
      await d.press(KEY.enter, "c", "n"); // confirm step, back to modes
      await d.press(KEY.enter);
      expect(d.text()).toContain("continue anyway"); // the earlier c does not carry over
      await d.press(KEY.esc, KEY.esc);
      expect(d.app.flow).toBeUndefined();
      expect(d.source.published).toEqual([]);
    });

    it("a blocked mode cannot continue at all, suspicious or not", async () => {
      const d = drive({ review: (s, mode) => ({ ...suspiciousReview(s, mode), blocked: true }) });
      await d.press("p", KEY.enter);
      expect(d.text()).toContain("✗ blocked");
      expect(d.text()).not.toContain("continue anyway");
    });

    it("a payload with nothing suspicious skips the extra step", async () => {
      const d = drive();
      await d.press("p", KEY.enter);
      expect(d.text()).toContain("Publish brief to");
      await d.press("y");
      expect(d.source.suspiciousConfirmed).toEqual([false]);
    });
  });

  it("says which sources supplied known secret values, and which were not read", async () => {
    const knownSources = [
      { id: "env" as const, enabled: true, count: 4 },
      { id: "projectEnv" as const, enabled: true, count: 2 },
      { id: "credentialFiles" as const, enabled: false, count: 0 },
      { id: "ghToken" as const, enabled: false, count: 0 },
    ];
    const d = drive({ review: (_, mode) => ({ mode, clean: true, blocked: false, findings: [], suspicious: [], knownSources, redactions: 0, bytes: 1000 }) });
    await d.press("p");
    const text = d.text().replace(/[│\s]+/g, " "); // the dialog box wraps the line
    expect(text).toContain("known values: env (4), project .env (2)");
    expect(text).toContain("not read: credential files, gh auth token (disabled)");
  });

  it("keeps the whole known-sources line, including what was not read, on a narrow terminal", async () => {
    const knownSources = [
      { id: "env" as const, enabled: true, count: 14 },
      { id: "projectEnv" as const, enabled: true, count: 12 },
      { id: "credentialFiles" as const, enabled: false, count: 0 },
      { id: "ghToken" as const, enabled: false, count: 0 },
      { id: "secrets-file" as const, enabled: true, count: 3 },
    ];
    const d = drive({ review: (_, mode) => ({ mode, clean: true, blocked: false, findings: [], suspicious: [], knownSources, redactions: 0, bytes: 1000 }) });
    await d.press("p");
    for (const width of [60, 44, 36]) {
      // Only the dialog's own rows: on a narrow screen the list behind it shows through right of the border.
      const lines = d.text(width, 40).split("\n");
      const dialog = lines.slice(lines.findIndex((l) => l.includes("╭─ Publish")), lines.findIndex((l) => l.includes("╰")));
      const text = dialog.map((l) => /^\s*│ ([^│]*)│/.exec(l)?.[1] ?? "").join(" ").replace(/\s+/g, " ");
      expect(text, `width ${width}`).toContain("known values: env (14), project .env (12), secrets file (3); not read: credential files, gh auth token (disabled)");
    }
  });

  it("cannot continue when publishing is not configured, and says why", async () => {
    const d = drive({ preflight: () => ({ error: "R2 credentials missing: set AGENT_SHARE_R2_ACCESS_KEY_ID", warnings: [] }) });
    await d.press("p");
    expect(d.text()).toContain("cannot publish");
    expect(d.text()).toContain("R2 credentials missing");
    await d.press(KEY.enter);
    expect(d.source.published).toEqual([]);
  });

  it("surfaces an upload failure, lets you go back, and does not mark the session shared", async () => {
    const d = drive({
      publish: async () => {
        throw new Error("gh: not logged in");
      },
    });
    await d.press("p", KEY.enter, "y");
    expect(d.text()).toContain("publishing failed");
    expect(d.text()).toContain("gh: not logged in");
    await d.press(KEY.enter); // back to mode selection
    expect(d.text()).toContain("enter continue");
    await d.press(KEY.esc);
    expect(d.text()).not.toContain("✓ shared");
  });

  it("shows post-upload warnings and flags a session that was already shared", async () => {
    const d = drive({
      shares: { "claude-code:s1": [{ url: "https://old", mode: "brief", target: "gist", sharedAt: new Date().toISOString() }] },
      publish: async () => ({ url: "https://new", warnings: ["the bucket's CORS policy does not allow the viewer"] }),
    });
    await d.press("p");
    expect(d.text()).toContain("already shared once");
    await d.press(KEY.enter, "y");
    expect(d.text()).toContain("warning: the bucket's CORS policy does not allow the viewer");
  });
});

describe("PublishFlow", () => {
  it("does not queue a scan per key while moving through modes quickly", async () => {
    const source = fakeSource();
    const flow = new PublishFlow(source, sampleSessions()[0]!, () => {}, () => {});
    flow.moveMode(-1); // full
    flow.moveMode(1); // brief
    flow.moveMode(1); // minimal
    flow.moveMode(1); // prompts
    await vi.advanceTimersByTimeAsync(500);
    // Only the mode the user settled on (prompts) was scanned; brief was the initial one, cancelled by the next key.
    expect(source.reviewed.map((r) => r.mode)).toEqual(["prompts"]);
    flow.dispose();
  });

  it("stops scanning after dispose", async () => {
    const source = fakeSource();
    const flow = new PublishFlow(source, sampleSessions()[0]!, () => {}, () => {});
    flow.dispose();
    await vi.advanceTimersByTimeAsync(500);
    expect(source.reviewed).toEqual([]);
  });
});
