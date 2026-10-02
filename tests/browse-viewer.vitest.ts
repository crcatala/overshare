import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { drive, KEY, listColumn, sampleView } from "./browse-helpers.js";
import { memorySettings } from "../src/browse/settings.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

async function open(opts: Parameters<typeof drive>[0] = {}) {
  const d = drive(opts);
  await d.press(KEY.enter); // opens the first session and lets it load
  return d;
}

describe("session viewer", () => {
  it("shows the tool-call breakdown, sorted by count, in the header", async () => {
    const d = await open();
    const text = d.text();
    expect(text).toMatch(/tools 22\s+Bash ×12\s+·\s+Read ×7\s+·\s+Edit ×3/);
    expect(text).toContain("$1.20");
    expect(text).toContain("2 turns");
  });

  it("starts on the conversation and cycles prompts-only → conversation → everything with v", async () => {
    const d = await open();
    expect(d.text()).toContain("user + assistant · 4 of 8");
    expect(d.text()).not.toContain("⚙");
    await d.press("v");
    expect(d.text()).toContain("everything · 8 of 8");
    expect(d.text()).toContain("⚙ Bash  npm test");
    expect(d.text()).toContain("… thinking (800 chars)");
    await d.press("v");
    expect(d.text()).toContain("user prompts only · 2 of 8");
    expect(d.text()).not.toContain("◆");
    await d.press("v");
    expect(d.text()).toContain("user + assistant");
  });

  it("Shift+V opens the same choice as a dialog", async () => {
    const d = await open();
    await d.press("V");
    expect(d.text()).toContain("Message list");
    await d.press(KEY.down, KEY.enter); // conversation → everything
    expect(d.text()).toContain("everything · 8 of 8");
  });

  it("keeps the selected message when the list level changes", async () => {
    const d = await open();
    await d.press(KEY.down); // assistant reply of turn 1
    expect(d.text()).toContain("Details follow.");
    await d.press("v"); // everything: the reply is now preceded by tool rows but still selected
    expect(d.text()).toContain("Details follow.");
    await d.press("v"); // prompts only: the reply is gone, so the next listed message (prompt 2) is selected
    expect(d.text()).toContain("now add a test for the USD fallback");
  });

  it("J and K jump between prompts, skipping everything else", async () => {
    const d = await open();
    await d.press("v"); // everything
    await d.press("J");
    expect(d.text()).toContain("now add a test for the USD fallback"); // turn 2's prompt
    await d.press("K");
    expect(d.text()).toContain("fix the bug in the invoice handler");
  });

  it("shows a tool error distinctly and the full body of the selected message", async () => {
    const d = await open();
    await d.press("v", KEY.down, KEY.down, KEY.down); // thinking, Bash, Edit (error)
    expect(d.text()).toContain("tool · Edit · error");
  });

  it("scrolls long content with space and says how much is hidden", async () => {
    const long = Array.from({ length: 80 }, (_, i) => `line ${i + 1}`).join("\n");
    const d = await open({ view: () => ({ ...sampleView(), items: [{ kind: "user", turn: 1, label: "long", body: long }] }) });
    expect(d.text()).toMatch(/↓ \d+ more lines/);
    expect(d.text()).not.toContain("line 80");
    await d.press(KEY.space, KEY.space, KEY.space, KEY.space, KEY.space, KEY.space, KEY.space, KEY.space, KEY.space, KEY.space);
    expect(d.text()).toContain("line 80");
  });

  it("reports the redaction status of a brief share once it has scanned", async () => {
    const d = await open({
      review: (_, mode) => ({ mode, clean: false, blocked: false, findings: [{ rule: "github-token", where: "turn 1", context: "x" }], redactions: 1, bytes: 1000 }),
    });
    expect(d.text()).toContain("! brief share: 1 finding redacted (github-token)");
  });

  it("copes with a redaction check that fails, and with a session that cannot be read", async () => {
    const failing = await open({
      review: () => {
        throw new Error("scan exploded");
      },
    });
    expect(failing.text()).toContain("redaction check unavailable: scan exploded");
    expect(failing.text()).toContain("$1.20"); // the viewer itself still works

    const broken = await open({
      view: () => {
        throw new Error("file vanished");
      },
    });
    expect(broken.text()).toContain("could not read this session: file vanished");
    await broken.press(KEY.esc);
    expect(broken.app.viewer).toBeUndefined(); // back on the list
  });

  it("esc returns to the list and p opens the publish dialog over the viewer", async () => {
    const d = await open();
    await d.press("p");
    expect(d.app.flow).toBeDefined();
    expect(d.text()).toContain("Publish");
    await d.press(KEY.esc); // cancel the flow; still in the viewer
    expect(d.app.viewer).toBeDefined();
    await d.press(KEY.esc);
    expect(d.app.viewer).toBeUndefined();
    expect(d.text()).toContain("agent-share");
  });
});

describe("view options (V)", () => {
  /** Columns between the list's cursor column and a row's icon, for the first row containing `text`. */
  const indentOf = (d: Awaited<ReturnType<typeof open>>, text: string): number => {
    const row = listColumn(d.lines()).find((l) => l.includes(text))!;
    const icon = row.search(/[❯◆⚙…⛭⚑]/u);
    return icon - 1; // minus the cursor column
  };

  it("lists the layout options below the list level, all on one dialog", async () => {
    const d = await open();
    await d.press("V");
    const text = d.text();
    expect(text).toContain("Message list");
    expect(text).toContain("Indent assistant replies");
    expect(text).toContain("Indent tool calls further");
  });

  it("is flat by default", async () => {
    const d = await open();
    await d.press("v"); // everything
    expect(indentOf(d, "fix the bug")).toBe(0);
    expect(indentOf(d, "Fixed: the default")).toBe(0);
    expect(indentOf(d, "Bash  npm test")).toBe(0);
  });

  it("indents replies one level and tool calls (and thinking) another when both are on", async () => {
    const settings = memorySettings({ viewer: { indentReplies: true, indentTools: true } });
    const d = await open({ settings });
    await d.press("v"); // everything
    expect(indentOf(d, "fix the bug")).toBe(0);
    expect(indentOf(d, "Fixed: the default")).toBe(2);
    expect(indentOf(d, "Bash  npm test")).toBe(4);
    expect(indentOf(d, "thinking (800 chars)")).toBe(4);
    expect(indentOf(d, "now add a test")).toBe(0); // the next prompt is back at the root
  });

  it("each option works alone: tool calls alone sit one level in, replies alone leave tools beside them", async () => {
    const tools = await open({ settings: memorySettings({ viewer: { indentTools: true } }) });
    await tools.press("v");
    expect(indentOf(tools, "Fixed: the default")).toBe(0);
    expect(indentOf(tools, "Bash  npm test")).toBe(2);
    const replies = await open({ settings: memorySettings({ viewer: { indentReplies: true } }) });
    await replies.press("v");
    expect(indentOf(replies, "Fixed: the default")).toBe(2);
    expect(indentOf(replies, "Bash  npm test")).toBe(2);
  });

  it("the dialog sets them, they apply at every list level, and v does not cycle them", async () => {
    const settings = memorySettings();
    const d = await open({ settings });
    // The cursor starts on the current level (conversation); two steps down is "yes" under "Indent assistant replies".
    await d.press("V", KEY.down, KEY.down, KEY.space); // replies: yes (stay open)
    expect(settings.get().viewer).toEqual({ indentReplies: true, indentTools: false });
    await d.press(KEY.down, KEY.down, KEY.enter); // past "no", onto "yes" under "Indent tool calls further"; choose and close
    expect(settings.get().viewer).toEqual({ indentReplies: true, indentTools: true });
    expect(d.text()).not.toContain("Indent tool calls further"); // closed
    expect(indentOf(d, "Fixed: the default")).toBe(2); // conversation level
    await d.press("v", "v", "v"); // around the cycle and back
    expect(settings.get().viewer).toEqual({ indentReplies: true, indentTools: true });
    await d.press("v");
    expect(indentOf(d, "Bash  npm test")).toBe(4);
  });

  it("choosing a list level in the dialog leaves the layout alone, and vice versa", async () => {
    const settings = memorySettings({ viewer: { indentReplies: true } });
    const d = await open({ settings });
    await d.press("V", KEY.down, KEY.enter); // conversation → everything
    expect(d.text()).toContain("everything · 8 of 8");
    expect(settings.get().viewer).toEqual({ indentReplies: true, indentTools: false });
  });

  it("applies to the next session you open too", async () => {
    const settings = memorySettings({ viewer: { indentReplies: true } });
    const d = await open({ settings });
    await d.press(KEY.esc, KEY.down, KEY.enter); // back to the list, open the second session
    expect(indentOf(d, "Fixed: the default")).toBe(2);
  });
});
