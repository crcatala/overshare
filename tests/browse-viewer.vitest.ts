import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ViewItem } from "../src/browse/source.js";
import { drive, KEY, sampleView, viewerPanes } from "./browse-helpers.js";
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

  it("scrolls long content once the content pane is focused, and says how much is hidden", async () => {
    const long = Array.from({ length: 80 }, (_, i) => `line ${i + 1}`).join("\n");
    const d = await open({ view: () => ({ ...sampleView(), items: [{ kind: "user", turn: 1, label: "long", body: long }] }) });
    expect(d.text()).toMatch(/↓ \d+ more lines · enter to read/);
    expect(d.text()).not.toContain("line 80");
    await d.press(KEY.enter, ...Array(10).fill(KEY.space));
    expect(d.text()).toContain("line 80");
  });

  it("reports the redaction status of a brief share once it has scanned", async () => {
    const d = await open({
      review: (_, mode) => ({ mode, clean: false, blocked: false, findings: [{ rule: "github-token", where: "turn 1", context: "x" }], suspicious: [], knownSources: [], redactions: 1, bytes: 1000 }),
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
    const row = viewerPanes(d.lines()).left.find((l) => l.includes(text))!;
    const icon = row.search(/[❯◆⚙…⛭⚑]/u);
    return icon - 2; // minus the panel border and the cursor column
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

  it("says so in the footer when a layout option could not be saved, and still applies it for this run", async () => {
    const settings = { ...memorySettings(), update: () => false };
    const d = await open({ settings });
    // The dialog cursor starts on the current level; two steps down is "yes" under "Indent assistant replies".
    await d.press("V", KEY.down, KEY.down, KEY.space);
    expect(d.lines().at(-1)).toContain("could not save settings");
    await d.press(KEY.down); // the next key clears the message
    expect(d.lines().at(-1)).not.toContain("could not save settings");
  });

  it("shows no warning when the layout option was saved", async () => {
    const d = await open({ settings: memorySettings() });
    await d.press("V", KEY.down, KEY.down, KEY.space);
    expect(d.text()).not.toContain("could not save settings");
  });

  it("applies to the next session you open too", async () => {
    const settings = memorySettings({ viewer: { indentReplies: true } });
    const d = await open({ settings });
    await d.press(KEY.esc, KEY.down, KEY.enter); // back to the list, open the second session
    expect(indentOf(d, "Fixed: the default")).toBe(2);
  });
});

describe("pane focus", () => {
  const longBody = Array.from({ length: 100 }, (_, i) => `line ${String(i + 1).padStart(3, "0")}`).join("\n");
  const longView = (n = 60) => ({
    ...sampleView(),
    items: Array.from({ length: n }, (_, i): ViewItem => ({ kind: i % 2 ? "assistant" : "user", turn: i + 1, label: `message ${String(i).padStart(2, "0")}`, body: i === 0 ? longBody : `body ${i}` })),
  });
  const SIZE: [number, number] = [120, 30]; // the list shows 30 − 5 header lines − rule − footer rows
  const selected = (d: Awaited<ReturnType<typeof open>>) => viewerPanes(d.lines(...SIZE)).left.find((l) => l.includes("▌"))?.match(/message (\d+)/)?.[1];
  const contentHas = (d: Awaited<ReturnType<typeof open>>, text: string) => viewerPanes(d.lines(...SIZE)).right.some((l) => l.includes(text));

  it("starts on the list; enter moves to the content pane, esc goes back, a second esc leaves the viewer", async () => {
    const d = await open();
    expect(d.app.viewer!.focus).toBe("list");
    await d.press(KEY.enter);
    expect(d.app.viewer!.focus).toBe("content");
    await d.press(KEY.esc);
    expect(d.app.viewer!.focus).toBe("list");
    expect(d.app.viewer).toBeDefined();
    await d.press(KEY.esc);
    expect(d.app.viewer).toBeUndefined();
  });

  it("tab cycles between the panes continuously; l focuses the content and h / q go back", async () => {
    const d = await open();
    const focus = () => d.app.viewer!.focus;
    await d.press("\t");
    expect(focus()).toBe("content");
    await d.press("\t");
    expect(focus()).toBe("list");
    await d.press("\t", "\t", "\t");
    expect(focus()).toBe("content");
    await d.press("h");
    expect(focus()).toBe("list");
    await d.press("l");
    expect(focus()).toBe("content");
    await d.press("q");
    expect(focus()).toBe("list");
    expect(d.app.viewer).toBeDefined();
  });

  it("does not focus an empty content pane", async () => {
    const d = await open({ view: () => ({ ...sampleView(), items: [] }) });
    await d.press(KEY.enter, "\t");
    expect(d.app.viewer!.focus).toBe("list");
  });

  /** The first body line of the content pane that is on screen (the pane's title and blank line scroll off first). */
  const firstLine = (d: Awaited<ReturnType<typeof open>>) => Number(viewerPanes(d.lines(...SIZE)).right.map((l) => l.match(/line (\d{3})/)?.[1]).find(Boolean));
  const atTop = (d: Awaited<ReturnType<typeof open>>) => contentHas(d, "line 001");

  it("the list pane pages with space / b, PgDn / PgUp, ctrl-f / ctrl-b and half pages with ctrl-d / ctrl-u", async () => {
    const d = await open({ view: () => longView() }); // the default level lists every message of this view
    d.lines(...SIZE);
    expect(selected(d)).toBe("00");
    await d.press(KEY.space);
    const page = Number(selected(d)); // a page is as many rows as the panes show
    expect(page).toBeGreaterThan(15);
    await d.press(KEY.pageDown);
    expect(selected(d)).toBe(String(2 * page).padStart(2, "0"));
    await d.press(KEY.ctrlB);
    expect(selected(d)).toBe(String(page).padStart(2, "0"));
    await d.press("b", KEY.pageUp);
    expect(selected(d)).toBe("00");
    await d.press(KEY.ctrlD);
    expect(Number(selected(d))).toBe(Math.floor(page / 2));
    await d.press(KEY.ctrlU);
    expect(selected(d)).toBe("00");
    await d.press(...Array(5).fill(KEY.ctrlF));
    expect(selected(d)).toBe("59"); // clamps at the end
  });

  it("in the content pane j/k, arrows, paging and g/G scroll the message and leave the selection alone", async () => {
    const d = await open({ view: () => longView() });
    d.lines(...SIZE);
    await d.press(KEY.enter);
    expect(atTop(d)).toBe(true);
    await d.press("j");
    expect(atTop(d)).toBe(false);
    expect(firstLine(d)).toBe(2);
    await d.press(KEY.down, "j");
    expect(firstLine(d)).toBe(4);
    await d.press("k", KEY.up, "k", "k", "k");
    expect(atTop(d)).toBe(true); // clamped at the top (more k presses than there was scroll)
    await d.press(KEY.space);
    expect(firstLine(d)).toBeGreaterThan(15); // a page, not a line
    await d.press("G");
    expect(contentHas(d, "line 100")).toBe(true);
    await d.press("g");
    expect(atTop(d)).toBe(true);
    await d.press(KEY.pageDown, KEY.ctrlD, KEY.ctrlU, KEY.pageUp, "b", KEY.home);
    expect(atTop(d)).toBe(true);
    expect(selected(d)).toBe("00"); // the list never moved
  });

  it("scrolling past the end does not build up hidden distance, so k moves straight back", async () => {
    const d = await open({ view: () => longView() });
    d.lines(...SIZE);
    await d.press(KEY.enter, "G");
    const bottom = firstLine(d);
    await d.press(...Array(30).fill("j"));
    expect(firstLine(d)).toBe(bottom);
    await d.press("k");
    expect(firstLine(d)).toBe(bottom - 1);
  });

  it("the list pane no longer scrolls the content: space moves the selection, and the content restarts at the top", async () => {
    const d = await open({ view: () => longView() });
    d.lines(...SIZE);
    await d.press(KEY.enter, KEY.space, KEY.esc); // scroll the content, then return to the list
    await d.press("j"); // next message: its scroll starts at the top again
    expect(selected(d)).toBe("01");
    expect(contentHas(d, "body 1")).toBe(true);
  });

  it("J and K still jump between prompts from the content pane, and v / V / p work there", async () => {
    const d = await open({ view: () => longView() });
    d.lines(...SIZE);
    await d.press(KEY.enter, "J");
    expect(selected(d)).toBe("02"); // the next user prompt
    expect(d.app.viewer!.focus).toBe("content");
    await d.press("V");
    expect(d.text()).toContain("Indent assistant replies");
    await d.press(KEY.esc);
    await d.press("p");
    expect(d.app.flow).toBeDefined();
  });

  it("draws each pane as a rounded panel, with the message heading in the content panel's top border", async () => {
    const d = await open({ view: () => longView() });
    const lines = d.lines(...SIZE);
    const top = lines.find((l) => l.includes("╭─"))!;
    expect(top.match(/╭─/g)).toHaveLength(2); // one panel per pane
    expect(top).toMatch(/╭─ user \+ assistant · 60 of 60 .*╮ ╭─ prompt  turn 1 .*╮/);
    const bottom = lines.find((l) => l.includes("╰"))!;
    expect(bottom).toMatch(/╰─+ 1\/60 ─╯ ╰─+ ↓ \d+ more lines · enter to read ─╯/);
    expect(lines.filter((l) => l.startsWith("│")).length).toBeGreaterThan(10); // both panels' sides
    // Nothing leaves the panels' rows: every one is a left panel, a gap and a right panel.
    for (const l of lines.filter((l) => l.startsWith("│"))) expect(l).toMatch(/^│.*│ │.*│$/);
  });

  it("the active panel has the bright border and the other one is gray", async () => {
    const d = await open({ view: () => longView() });
    const raw = () => d.app.render(120).find((l) => l.includes("╭─") && l.includes("prompt"))!;
    const edges = () => [...raw().matchAll(/\x1b\[(36|90)m╭─/g)].map((m) => m[1]);
    expect(edges()).toEqual(["36", "90"]); // list active
    await d.press(KEY.enter);
    expect(edges()).toEqual(["90", "36"]); // content active
    await d.press("\t");
    expect(edges()).toEqual(["36", "90"]);
  });

  it("shows which pane has the focus: the selected row dims, the content panel's border hints at the keys, the footer changes", async () => {
    const d = await open({ view: () => longView() });
    const raw = () => d.app.render(120).join("\n");
    expect(raw()).toContain("\x1b[48;5;238m"); // focused selection
    expect(raw()).not.toContain("\x1b[48;5;236m\x1b[");
    expect(d.lines().at(-1)).toContain("enter/tab");
    expect(d.text()).toContain("enter to read");
    await d.press(KEY.enter);
    expect(raw()).toContain("\x1b[48;5;236m"); // dimmed selection while the content has the focus
    expect(raw()).not.toContain("\x1b[48;5;238m");
    expect(d.text()).toMatch(/↓ \d+ more lines · j\/k scroll · space\/b page · tab\/esc back/);
    expect(d.text()).not.toContain("enter to read");
    expect(d.lines().at(-1)).toContain("tab/esc");
  });
});
