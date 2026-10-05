/** Search highlighting in the browser: the session list and its preview, and the viewer's own search. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseSession } from "../src/adapters/index.js";
import { viewFromSession } from "../src/browse/job.js";
import { HIT_ON } from "../src/browse/mark.js";
import type { SessionView, ViewItem } from "../src/browse/source.js";
import { drive, KEY, listColumn, sampleView, summary, viewerPanes, type Driver } from "./browse-helpers.js";
import { ccUsage, ClaudeTranscript } from "./helpers.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

/** The screen with its escape sequences, at the same size `Driver.lines` draws. */
const raw = (d: Driver, width = 130, height = 34): string[] => {
  d.lines(width, height);
  return d.app.render(width);
};
const hitsIn = (lines: string[]): number => lines.join("\n").split(HIT_ON).length - 1;
/** A raw screen line cut at the gap between the viewer's panels (the borders carry colours). */
const panes = (line: string): string[] => line.split(/\x1b\[39m \x1b\[\d+m[│╭╰]/);
const unstyledRow = (line: string): string => line.replace(/\x1b\[[0-9;]*m/g, "");
const marked = (line: string): string[] => [...line.matchAll(new RegExp(`${HIT_ON.replace(/[[\]]/g, "\\$&")}(.*?)\\x1b\\[39m`, "g"))].map((m) => m[1]!);

describe("session list search highlighting", () => {
  it("highlights the words in the title, repo and branch of a row, and in nothing else", async () => {
    const d = drive({
      sessions: [summary({ id: "a", title: "Fix invoice currency bug", project: "invoice-service", branch: "invoice-fix", firstPrompt: "first prompt" })],
      query: "invoice",
    });
    const rows = listColumn(raw(d, 180)).filter((l) => l.includes("Fix "));
    expect(rows).toHaveLength(1);
    expect(marked(rows[0]!)).toEqual(["invoice", "invoice", "invoice"]); // repo, branch (when it fits), title
    expect(d.text()).toContain("Fix invoice currency bug"); // the text itself is unchanged
  });

  it("highlights nothing without a search, for a one-letter word, or for a filter like harness:pi", async () => {
    expect(hitsIn(raw(drive()))).toBe(0);
    expect(hitsIn(raw(drive({ query: "i" })))).toBe(0);
    expect(hitsIn(raw(drive({ query: "harness:pi" })))).toBe(0);
  });

  it("also highlights the selected row, whose own background comes back after each hit", async () => {
    const d = drive({ query: "invoice" });
    const selected = raw(d).find((l) => l.includes("▌"))!;
    expect(marked(selected).length).toBeGreaterThan(0);
    expect(selected).toContain("\x1b[49m\x1b[48;5;238m");
  });

  it("highlights the words in the preview's prompts as well", async () => {
    const d = drive({
      sessions: [summary({ id: "a", title: "Money", firstPrompt: "POST /v1/invoices returns 500", promptHead: ["POST /v1/invoices returns 500", "second", "third"], searchText: "money\napp\npost /v1/invoices returns 500" })],
      query: "invoices",
    });
    const preview = raw(d).map((l) => l.split(" │ ").slice(1).join(" │ "));
    expect(preview.filter((l) => marked(l).includes("invoices")).length).toBeGreaterThanOrEqual(2); // first prompt and the prompt list
  });
});

describe("session list: what matched", () => {
  const long = summary({
    id: "deep",
    title: "Billing cleanup",
    firstPrompt: "set up the repo",
    lastPrompt: "ship it",
    promptHead: ["set up the repo", "Wire the Webhook retries into the queue", "third", "fourth"],
    searchText: "billing cleanup\napp\nset up the repo\nwire the webhook retries into the queue\nrotate the stripe signing secret before friday",
  });

  it("quotes the prompt a word was found in, in its own case, when the list row cannot show it", async () => {
    const d = drive({ sessions: [long], query: "webhook" });
    const text = d.text();
    expect(text).toContain("matched in prompts");
    expect(text).toContain("· Wire the Webhook retries into the queue");
  });

  it("falls back to the search index's text (lower-case) for a word beyond the prompts the preview keeps", async () => {
    const d = drive({ sessions: [long], query: "stripe" });
    expect(d.text()).toContain("· rotate the stripe signing secret before friday");
  });

  it("explains each word with the prompt that holds the most words still unexplained", async () => {
    const d = drive({ sessions: [long], query: "webhook stripe" });
    const text = d.text();
    expect(text).toContain("· Wire the Webhook retries into the queue");
    expect(text).toContain("· rotate the stripe signing secret");
  });

  it("quotes a word that sits far from the first one in the same prompt, not just the part around the first", async () => {
    const far = `Wire the webhook retries into the queue ${"and keep the handler small. ".repeat(12)}then rotate the stripe signing secret`;
    const d = drive({ sessions: [summary({ id: "far", title: "Billing cleanup", firstPrompt: "set up", promptHead: ["set up", far], searchText: `billing cleanup\napp\nset up\n${far.toLowerCase()}` })], query: "webhook stripe" });
    const text = d.text();
    expect(text).toContain("webhook retries");
    expect(text).toContain("rotate the stripe signing secret");
  });

  it("says nothing when the title already shows why the session matched", async () => {
    const d = drive({ sessions: [long], query: "billing" });
    expect(d.text()).not.toContain("matched in prompts");
  });

  it("says nothing without a search", async () => {
    expect(drive({ sessions: [long] }).text()).not.toContain("matched in prompts");
  });
});

// ── the viewer ─────────────────────────────────────────────────────────────────────────

const item = (over: Partial<ViewItem> & Pick<ViewItem, "kind" | "turn" | "label" | "body">): ViewItem => over;

/** A prompt, a reply, two tool calls (one holds the word only in its output) and a second turn. */
function searchView(): SessionView {
  const result = "src/money.ts:3: export const currency = 'USD'";
  const items: ViewItem[] = [
    item({ kind: "user", turn: 1, label: "fix the invoice bug", body: "fix the invoice bug" }),
    item({ kind: "assistant", turn: 1, label: "Found it: the default is missing.", body: "Found it: the default is missing.\n\nThe currency default is missing, so set currency to USD." }),
    item({
      kind: "tool",
      turn: 1,
      label: "Bash  grep -rn currency src",
      meta: "Bash",
      body: `grep -rn currency src\n\n── input ──\n{}\n\n── result ──\nsrc/invoice.ts:12: nothing here`,
      blocks: [{ type: "code", text: "grep -rn currency src", lang: "bash" }, { type: "label", text: "result", output: true }, { type: "code", text: "src/invoice.ts:12: nothing here", output: true }],
    }),
    item({
      kind: "tool",
      turn: 1,
      label: "Read  src/money.ts",
      meta: "Read",
      body: `src/money.ts\n\n── input ──\n{}\n\n── result ──\n${result}`,
      blocks: [{ type: "label", text: "src/money.ts" }, { type: "label", text: "result", output: true }, { type: "code", text: result, output: true }],
    }),
    item({ kind: "user", turn: 2, label: "now add a test", body: "now add a test" }),
    item({ kind: "assistant", turn: 2, label: "Added the regression test.", body: "Added the regression test." }),
  ];
  return { ...sampleView(), items };
}

/** The one session whose search text holds "needle". */
const needle = summary({ id: "n", title: "Find the needle" });

async function openViewer(opts: Parameters<typeof drive>[0] = {}) {
  const d = drive({ view: searchView, ...opts });
  await d.press(KEY.enter);
  return d;
}

describe("viewer search", () => {
  it("opens on the first message holding the words handed over from the list, highlights them, and leaves the list whole", async () => {
    const d = await openViewer({ query: "currency" });
    const text = d.text();
    expect(text).toContain("/ currency");
    expect(text).toContain("user + assistant · 4 of 6"); // not narrowed
    const { left, right } = viewerPanes(d.lines());
    expect(left.join("\n")).toContain("▌◆ Found it"); // the reply: the first message with the word, not the prompt before it
    expect(right.join("\n")).toContain("The currency default is missing");
    const pane = raw(d).map((l) => panes(l)[1] ?? "");
    expect(marked(pane.join("\n")).length).toBe(2); // both "currency"s in the reply
  });

  it("counts the messages that hold the words, and the ones in kinds the list is not showing", async () => {
    const d = await openViewer({ query: "currency" });
    expect(d.text()).toMatch(/\/ currency\s+1 message · \+1 in hidden kinds \(v\)/);
    await d.press("v"); // everything
    expect(d.text()).toMatch(/2 messages/);
    expect(d.text()).toContain("+1 in tool output (o)");
  });

  it("starts on the first message when it cannot find the words in any, and says so", async () => {
    const d = await openViewer({ query: "billing" }); // the repo's name: in no message
    expect(d.text()).toContain("/ billing   no message");
    expect(d.text()).toContain("user + assistant · 4 of 6");
  });

  it("/ narrows the list to the messages holding every word, while typing, and esc clears it", async () => {
    const d = await openViewer();
    await d.press("v"); // everything
    await d.press("/");
    await d.type("currency");
    await d.press(KEY.enter);
    let text = d.text();
    expect(text).toContain("everything · 2 of 6");
    expect(text).toContain("Bash  grep -rn currency src");
    expect(text).not.toContain("Read  src/money.ts"); // its output holds the word, its input does not
    expect(text).not.toContain("now add a test");
    await d.press(KEY.esc); // clears the search first, stays in the viewer
    text = d.text();
    expect(text).toContain("everything · 6 of 6");
    expect(text).not.toContain("/ currency");
    expect(text).toContain("overshare  ›");
  });

  it("needs every word in one message", async () => {
    const d = await openViewer();
    await d.press("v", "/");
    await d.type("currency invoice");
    expect(d.text()).toContain("everything · 0 of 6");
    expect(d.text()).toContain("no message");
  });

  it("o adds tool output to what is searched", async () => {
    const d = await openViewer();
    await d.press("v", "/");
    await d.type("currency");
    await d.press(KEY.enter, "o");
    expect(d.text()).toContain("everything · 3 of 6");
    expect(d.text()).toContain("Read  src/money.ts");
    expect(d.text()).toContain("tool output included");
    await d.press("o");
    expect(d.text()).toContain("everything · 2 of 6");
  });

  it("does not search the layout words between a tool's input and result", async () => {
    const d = await openViewer();
    await d.press("v", "/");
    await d.type("result");
    expect(d.text()).toContain("everything · 0 of 6");
  });

  it("keeps the selected message when the search is cleared with x", async () => {
    const d = await openViewer();
    await d.press("v", "/");
    await d.type("regression");
    await d.press(KEY.enter);
    expect(d.text()).toContain("everything · 1 of 6");
    await d.press("x");
    const { left } = viewerPanes(d.lines());
    expect(left.join("\n")).toContain("▌◆ Added the regression test.");
    expect(d.text()).toContain("everything · 6 of 6");
  });

  it("esc leaves the viewer when the words only came from the list, and x clears them", async () => {
    const d = await openViewer({ query: "currency" });
    await d.press("x");
    expect(d.text()).not.toContain("/ currency");
    expect(d.text()).toContain("overshare  ›");
    const e = await openViewer({ query: "currency" });
    await e.press(KEY.esc);
    expect(e.text()).not.toContain("overshare  ›"); // back in the session list
  });

  it("/ over words handed over from the list starts a new search instead of adding to them", async () => {
    const d = await openViewer({ query: "currency" });
    await d.press("/");
    expect(d.text()).toContain("user + assistant · 4 of 6"); // nothing changed yet: the old words still highlight
    await d.type("regression");
    await d.press(KEY.enter);
    const text = d.text();
    expect(text).toContain("/ regression");
    expect(text).not.toContain("currencyregression");
    expect(text).toContain("user + assistant · 1 of 6");
    // a search typed here is edited in place, not replaced
    await d.press("/");
    await d.type("s");
    expect(d.text()).toContain("/ regressions");
  });

  it("n and N step through the messages in the list, and say when there are no more", async () => {
    const d = await openViewer({ query: "currency" });
    await d.press("v"); // everything: the reply, the Bash call
    const at = () => viewerPanes(d.lines()).left.find((l) => l.includes("▌"))!;
    expect(at()).toContain("Found it");
    await d.press("n");
    expect(at()).toContain("Bash  grep");
    await d.press("n");
    expect(at()).toContain("Bash  grep"); // nothing later holds the word
    expect(d.text()).toContain("no later message holds the words");
    await d.press("N");
    expect(at()).toContain("Found it");
  });

  it("highlights every hit in the content pane, and steps from line to line with n and N", async () => {
    const lines = Array.from({ length: 60 }, (_, i) => (i === 5 || i === 30 || i === 55 ? `line ${i + 1} has the needle` : `line ${i + 1}`)).join("\n");
    const d = await openViewer({ sessions: [needle], view: () => ({ ...sampleView(), items: [item({ kind: "assistant", turn: 1, label: "long", body: lines })] }), query: "needle" });
    expect(d.text()).toContain("3 hits · n/N");
    await d.press(KEY.enter); // read: focus the content pane
    const top = () => viewerPanes(d.lines()).right.find((l) => /line \d+/.test(l))!.match(/line (\d+)/)![1]!;
    expect(top()).toBe("1"); // the first hit is on screen already: the pane stays at the top
    await d.press("n"); // line 31
    expect(Number(top())).toBeGreaterThan(20);
    expect(d.text()).toContain("line 31 has the needle");
    await d.press("n");
    expect(d.text()).toContain("line 56 has the needle");
    await d.press("N", "N");
    expect(d.text()).toContain("line 6 has the needle");
  });

  it("starts at a hit that is out of sight, and n past the last hit goes on to the next message", async () => {
    const far = Array.from({ length: 60 }, (_, i) => (i === 50 ? "the needle is here" : `filler ${i}`)).join("\n");
    const items = [item({ kind: "assistant", turn: 1, label: "far", body: far }), item({ kind: "assistant", turn: 2, label: "near", body: "a needle too" })];
    const d = await openViewer({ sessions: [needle], view: () => ({ ...sampleView(), items }), query: "needle" });
    expect(d.text()).toContain("the needle is here"); // scrolled to it
    await d.press(KEY.enter, "n");
    expect(viewerPanes(d.lines()).left.find((l) => l.includes("▌"))).toContain("near");
    await d.press("N");
    expect(viewerPanes(d.lines()).left.find((l) => l.includes("▌"))).toContain("far");
    expect(d.text()).toContain("the needle is here"); // N lands on the last hit of the earlier message
  });

  it("marks the words in list rows that show them, with a count of the hits the row hides", async () => {
    const d = await openViewer({ query: "currency" });
    await d.press("v");
    const rows = raw(d).map((l) => panes(l)[0]!);
    const reply = rows.find((l) => l.includes("Found it"))!;
    expect(reply).toContain("×2"); // two in the body, none in the one-line label
    const bash = rows.find((l) => l.includes("Bash  grep"))!;
    expect(marked(bash)).toContain("currency");
  });

  it("does not half-highlight a word that the row's cut runs through", async () => {
    // Slide the word along the row so that the cut falls at every point of it in turn.
    const cuts = new Set<string>();
    for (let pad = 36; pad <= 48; pad++) {
      const label = `${"a".repeat(pad)} currency and then some`;
      const d = await openViewer({ view: () => ({ ...sampleView(), items: [item({ kind: "assistant", turn: 1, label, body: label })] }), query: "currency" });
      const row = raw(d).map((l) => panes(l)[0]!).find((l) => l.includes("aaaa"))!;
      cuts.add(/(c|cu|cur|curr|curre|curren|currenc|currency)…/.exec(unstyledRow(row))?.[1] ?? "");
      expect(marked(row).filter((m) => m !== "currency")).toEqual([]); // a hit is a whole word or nothing
    }
    expect(cuts.has("c") && cuts.has("curren")).toBe(true); // the cut did run through the word
  });

  it("counts the hits the way the pane shows them: once per place, not once for the label and again for the body", async () => {
    const d = await openViewer({ query: "currency" });
    const row = raw(d).map((l) => panes(l)[0]!).find((l) => l.includes("Found it"))!;
    expect(row).toContain("×2");
    const prompt = viewerPanes(d.lines()).left.find((l) => l.includes("fix the invoice bug"));
    expect(prompt).not.toContain("×"); // no hit in a message that does not hold the word
  });

  it("highlights words in a tool call's code, colours kept", async () => {
    const items = [item({ kind: "tool", turn: 1, label: "Bash  npm test", meta: "Bash", body: "npm test", blocks: [{ type: "code", text: "npm test -- --grep needle", lang: "bash" }] })];
    const d = await openViewer({ sessions: [needle], view: () => ({ ...sampleView(), items }), query: "needle" });
    await d.press("v"); // everything: the call's command is a code block in the pane
    const out = raw(d).map((l) => panes(l)[1] ?? "").join("\n");
    expect(marked(out)).toContain("needle");
  });

  it("types a search with the footer showing what the keys do, and ignores / before the session has loaded", async () => {
    const d = await openViewer();
    await d.press("/");
    expect(d.text()).toContain("enter done");
    expect(d.text()).toContain("esc clear");
    await d.type("cur");
    expect(d.text()).toContain("/ cur");
  });
});

describe("viewer search covers what the pane shows", () => {
  const filler = "x ".repeat(1_600); // 3,200 characters: past where a tool call's JSON input is cut for the body

  /** A session read through the real view builder, so the items have the blocks and caps the pane is drawn from. */
  const viewOf = (build: (t: ClaudeTranscript) => ClaudeTranscript) => () => viewFromSession(parseSession(build(new ClaudeTranscript().user("go")).toJsonl(), "claude-code").session);
  const call = (t: ClaudeTranscript, name: string, input: Record<string, unknown>) =>
    t.assistant("m1", [{ type: "tool_use", id: "t1", name, input }], ccUsage(1, 1)).toolResult("t1", "ok");

  async function search(view: () => SessionView, text: string) {
    const d = await openViewer({ view });
    await d.press("v", "/");
    await d.type(text);
    await d.press(KEY.enter);
    return d;
  }

  it("finds a word in the lower part of a large edit, which the pane draws in full", async () => {
    const d = await search(viewOf((t) => call(t, "Edit", { file_path: "src/a.ts", old_string: "const a = 1;", new_string: `${filler}\nconst zebrafish = 2;` })), "zebrafish");
    expect(d.text()).toContain("everything · 1 of ");
    expect(d.text()).toContain("Edit  src/a.ts");
  });

  it("finds a word in the end of a written file", async () => {
    const d = await search(viewOf((t) => call(t, "Write", { file_path: "src/b.ts", content: `${filler}\nexport const zebrafish = 2;` })), "zebrafish");
    expect(d.text()).toContain("everything · 1 of ");
  });

  it("finds a word with the quotes or backslashes the pane shows, which the JSON input would escape", async () => {
    const quoted = await search(viewOf((t) => call(t, "Bash", { command: 'echo "hello world"' })), '"hello');
    expect(quoted.text()).toContain("everything · 1 of ");
    const slashed = await search(viewOf((t) => call(t, "Bash", { command: "ls C:\\data\\files" })), "c:\\data");
    expect(slashed.text()).toContain("everything · 1 of ");
  });

  it("still leaves a tool's result and the layout words out unless asked", async () => {
    const view = viewOf((t) => t.assistant("m1", [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }], ccUsage(1, 1)).toolResult("t1", "zebrafish.txt"));
    const without = await search(view, "zebrafish");
    expect(without.text()).toContain("everything · 0 of ");
    await without.press("o");
    expect(without.text()).toContain("everything · 1 of ");
    expect((await search(view, "result")).text()).toContain("everything · 0 of ");
  });
});
