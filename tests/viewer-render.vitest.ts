// @vitest-environment jsdom
/** What the transcript and token rail render for the session data they're given. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { SCHEMA_VERSION, type NormalizedSession, type ShareMode, type Step, type Turn, type Usage } from "../src/schema.ts";

(globalThis as { __AGENT_SHARE_SOURCES__?: Record<string, string> }).__AGENT_SHARE_SOURCES__ = {};
const { renderTranscript } = await import("../viewer/src/transcript.ts");
const { renderTokenRail } = await import("../viewer/src/tokens.ts");
const { renderHeader } = await import("../viewer/src/header.ts");
const { closeHoverCard } = await import("../viewer/src/popover.ts");
const { closeMenus } = await import("../viewer/src/menu.ts");
const { projectSession } = await import("../src/modes.ts");
const { VARIANTS } = await import("../viewer/src/variants.ts");

const usage = (context: number, output: number): Usage => ({ input: 0, output, cacheRead: context, cacheWrite: 0, reasoning: 0 });

function session(turns: Turn[], responses: NormalizedSession["responses"] = []): NormalizedSession {
  return {
    schema: SCHEMA_VERSION,
    mode: "full",
    harness: { name: "pi" },
    source: { sessionId: "test" },
    project: { cwd: "~/work/app", name: "app" },
    models: [],
    stats: {
      turns: turns.length,
      userPrompts: turns.length,
      responses: responses.length,
      toolCalls: 0,
      tools: {},
      toolErrors: 0,
      thinking: { blocks: 0, chars: 0, tokens: 0 },
      subagents: 0,
      compactions: 0,
      files: { read: 0, edited: 0, written: 0 },
      tokens: usage(0, 0),
      peakContext: Math.max(0, ...responses.map((r) => r.usage.cacheRead)),
    },
    responses,
    turns,
  };
}

const turn = (index: number, steps: Step[], text = `prompt ${index}`): Turn => ({ index, user: { text, authored: true }, steps });

describe("token rail", () => {
  // Regression: the per-turn chart used to scale each turn to its own tallest call, so
  // every turn filled the chart the same way whatever its size.
  it("draws each turn's model calls on one session-wide scale", () => {
    const s = session(
      [turn(0, [{ kind: "text", id: "a", text: "small turn" }]), turn(1, [{ kind: "text", id: "b", text: "big turn" }])],
      [
        { id: "r0", turn: 0, usage: usage(1_000, 50) },
        { id: "r1", turn: 1, usage: usage(5_000, 50) },
        { id: "r2", turn: 1, usage: usage(10_000, 100) },
      ],
    );
    const { turns } = renderTranscript(s);
    const rail = renderTokenRail(s, turns, () => {});
    const barHeights = () =>
      Array.from(rail.el.querySelectorAll(".rail-turn .cols:not(.cols-out) .col"), (col) =>
        Array.from(col.querySelectorAll<HTMLElement>(".seg")).reduce((n, seg) => n + parseFloat(seg.style.height), 0),
      );

    rail.setActive(1);
    const [mid, peak] = barHeights();
    expect(peak).toBe(36); // the session's largest call fills the chart
    expect(mid).toBeCloseTo(18, 0);

    rail.setActive(0);
    const [small] = barHeights();
    expect(small).toBeLessThan(6); // 1k of a 10k peak, not a full-height bar
    expect(rail.el.querySelector(".rail-turn .chart-axis")?.textContent).toBe("10.0k");
  });
});

describe("token rail tools", () => {
  const shell = (id: string, command: string): Step => ({ kind: "tool", id, name: "Bash", action: "exec", summary: command, input: { command } });
  const withTools = (steps: Step[], tools: Record<string, number>) => {
    const s = session([turn(0, steps)]);
    s.stats.tools = tools;
    s.stats.toolCalls = Object.values(tools).reduce((a, b) => a + b, 0);
    return s;
  };
  const rows = (s: NormalizedSession) => {
    const { turns } = renderTranscript(s);
    return Array.from(renderTokenRail(s, turns, () => {}).el.querySelectorAll(".bars-row"), (r) => [r.classList.contains("bars-sub"), r.querySelector(".bars-name")?.textContent, r.querySelector(".bars-n")?.textContent]);
  };

  it("nests shell calls by program under the shell tool's total", () => {
    const s = withTools([shell("a", "git status"), shell("b", "git diff"), shell("c", "npm test"), { kind: "tool", id: "d", name: "Edit", action: "edit", summary: "a.ts" }], { Bash: 3, Edit: 1 });
    expect(rows(s)).toEqual([
      [false, "Bash", "3"],
      [true, "git", "2"],
      [true, "npm", "1"],
      [false, "Edit", "1"],
    ]);
  });

  it("does the same from a brief view's groups, and lists no programs in minimal", () => {
    const full = withTools([shell("a", "git status"), shell("b", "git diff"), shell("c", "ls")], { Bash: 3 });
    expect(rows(projectSession(full, "brief"))).toEqual([
      [false, "Bash", "3"],
      [true, "git", "2"],
      [true, "ls", "1"],
    ]);
    expect(rows(projectSession(full, "minimal"))).toEqual([[false, "Bash", "3"]]);
  });

  it("folds programs beyond the first few behind a toggle that expands them", () => {
    const programs = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"];
    const s = withTools(programs.map((p, i) => shell(`s${i}`, `${p} x`)), { Bash: programs.length });
    const { turns } = renderTranscript(s);
    const rail = renderTokenRail(s, turns, () => {});
    const subs = () => Array.from(rail.el.querySelectorAll(".bars-sub.bars-row .bars-name"), (n) => n.textContent);
    const toggle = () => rail.el.querySelector<HTMLButtonElement>("button.bars-toggle")!;
    expect(subs()).toEqual(["a", "b", "c", "d", "e", "f", "g", "h"]);
    expect(toggle().textContent).toBe("+2 more");
    toggle().click();
    expect(subs()).toEqual(programs);
    expect(toggle().textContent).toBe("show fewer");
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    toggle().click();
    expect(subs()).toHaveLength(8);
  });

  it("shows unnamed shell calls as an 'other' row, expandable with the rest when there are many programs", () => {
    const few = withTools([shell("a", "git status"), shell("b", "")], { Bash: 2 });
    const { turns } = renderTranscript(few);
    const rail = renderTokenRail(few, turns, () => {});
    expect(Array.from(rail.el.querySelectorAll(".bars-sub.bars-row .bars-name"), (n) => n.textContent)).toEqual(["git", "other"]);
    expect(rail.el.querySelector("button.bars-toggle")).toBeNull();
  });
});

describe("shell calls of a brief group", () => {
  // The chips, the outline, the rail and the call lists all split a group's shell calls by program,
  // and must agree on when the group's commands can be attributed.
  const group = (commands: string[]): Step => ({ kind: "toolGroup", id: "g", calls: [{ name: "Bash", count: 1, errors: 0 }], total: 1, files: { read: [], edited: [], written: [] }, commands, responseIds: [] });

  it.each([
    ["attributes commands that fit the calls", ["git status"], "Bash(git)", ["git"]],
    ["does not attribute more commands than calls", ["git status", "ls"], "Bash", []],
  ])("%s", (_name, commands, chip, railPrograms) => {
    const s = session([turn(0, [group(commands)])]);
    s.stats.tools = { Bash: 1 };
    const { turns, el } = renderTranscript(s);
    expect(el.querySelector(".chip")?.textContent).toBe(chip);
    expect(turns[0]!.items[0]!.label).toBe(chip);
    expect(turns[0]!.calls.some((c) => c.program)).toBe(railPrograms.length > 0);
    const rail = renderTokenRail(s, turns, () => {});
    expect(Array.from(rail.el.querySelectorAll(".bars-sub.bars-row .bars-name"), (n) => n.textContent)).toEqual(railPrograms);
  });
});

describe("tool call lists", () => {
  const shell = (id: string, command: string, extra: Partial<Extract<Step, { kind: "tool" }>> = {}): Step => ({ kind: "tool", id, name: "Bash", action: "exec", summary: command, input: { command }, ...extra });

  it("lists each call of a turn with the step it lives in, in order", () => {
    const { turns, el } = renderTranscript(
      session([
        turn(0, [shell("a", "git status"), { kind: "tool", id: "b", name: "Edit", action: "edit", summary: "~/work/app/src/a.ts", input: {} } as Step, shell("c", "npm test", { isError: true }), { kind: "subagent", id: "d", tool: "Agent", agents: ["scout"], description: "find it" } as Step]),
      ]),
    );
    expect(turns[0]!.calls.map((c) => [c.tool, c.program, c.preview, c.error ?? false])).toEqual([
      ["Bash", "git", "git status", false],
      ["Edit", undefined, "src/a.ts", false],
      ["Bash", "npm", "npm test", true],
      ["Agent", undefined, "find it", false],
    ]);
    // Every call points at an entry that exists.
    for (const c of turns[0]!.calls) expect(el.querySelector(`#${c.id}`)).not.toBeNull();
  });

  it("lists a brief group's commands one by one and its other tools by count, all pointing at the group", () => {
    const group: Step = { kind: "toolGroup", id: "g", calls: [{ name: "Bash", count: 3, errors: 0 }, { name: "Read", count: 2, errors: 0 }], total: 5, files: { read: [], edited: [], written: [] }, commands: ["git status", "ls"], responseIds: [] };
    const { turns, el } = renderTranscript(session([turn(0, [group])]));
    expect(turns[0]!.calls.map((c) => [c.tool, c.program, c.preview, c.count])).toEqual([
      ["Bash", "git", "git status", undefined],
      ["Bash", "ls", "ls", undefined],
      ["Bash", undefined, "command not kept", 1],
      ["Read", undefined, "details not kept in this view", 2],
    ]);
    const ids = new Set(turns[0]!.calls.map((c) => c.id));
    expect(ids.size).toBe(1);
    expect(el.querySelector(`#${[...ids][0]}`)).not.toBeNull();
  });

  it("gives each rail row a card with its calls, and picking one jumps to its step", () => {
    const s = session([turn(0, [shell("a", "git status"), shell("b", "git diff"), shell("c", "ls")])]);
    s.stats.tools = { Bash: 3 };
    const { turns } = renderTranscript(s);
    const jumped: string[] = [];
    const rail = renderTokenRail(s, turns, () => {}, (id) => jumped.push(id));
    document.body.replaceChildren(rail.el);
    const row = (name: string) => Array.from(rail.el.querySelectorAll<HTMLElement>(".bars-row")).find((r) => r.querySelector(".bars-name")?.textContent === name)!;
    // The keyboard opens a card without waiting on a hover.
    const open = (name: string) => row(name).dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    open("Bash");
    const items = () => Array.from(document.querySelectorAll<HTMLElement>(".hcard .hc-item .hc-text"), (n) => n.textContent);
    expect(document.querySelector(".hcard .hc-title")?.textContent).toBe("Bash");
    expect(document.querySelector(".hcard .hc-count")?.textContent).toBe("3 calls");
    expect(items()).toEqual(["git status", "git diff", "ls"]);
    document.querySelector<HTMLElement>(".hcard .hc-item")!.click();
    expect(jumped).toEqual([turns[0]!.calls[0]!.id]);
    expect(document.querySelector(".hcard")).toBeNull();

    open("git");
    expect(document.querySelector(".hcard .hc-title")?.textContent).toBe("Bash(git)");
    expect(items()).toEqual(["git status", "git diff"]);
    closeHoverCard();
  });
});

describe("transcript tool entries", () => {
  const tool = (step: Partial<Extract<Step, { kind: "tool" }>>): Step => ({ kind: "tool", id: "t", name: "Bash", action: "exec", summary: "", ...step }) as Step;

  function render(steps: Step[]) {
    const { el } = renderTranscript(session([turn(0, steps)]));
    return Array.from(el.querySelectorAll<HTMLElement>(".entry:not(.k-user)"));
  }

  it("shows a command with a short output preview and builds the rest on open", () => {
    const output = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n");
    const [entry] = render([tool({ summary: "npm test", input: { command: "npm test" }, result: { text: output } })]);
    expect(entry!.querySelector(".targ")?.textContent).toBe("npm test");
    expect(entry!.querySelector(".tprev pre")?.textContent).toBe("line 1\nline 2\nline 3");
    expect(entry!.querySelector(".tprev .more")?.textContent).toBe("… +7 lines");
    const full = entry!.querySelector<HTMLElement>(".tfull")!;
    expect(full.childElementCount).toBe(0); // lazy
    entry!.querySelector<HTMLButtonElement>("button.tline")!.click();
    expect(full.hidden).toBe(false);
    expect(full.textContent).toContain("line 10");
  });

  it("shows an edit as a diff with added/removed counts, paths relative to the project", () => {
    const [entry] = render([
      tool({ name: "Edit", action: "edit", summary: "~/work/app/src/a.ts", input: { old_string: "a\nb\nc", new_string: "a\nB\nc" }, result: { text: "ok" } }),
    ]);
    expect(entry!.querySelector(".targ")?.textContent).toBe("src/a.ts");
    expect(entry!.querySelector(".tmeta")?.textContent).toBe("+1 −1");
    expect(Array.from(entry!.querySelectorAll(".tprev .d-del, .tprev .d-add"), (d) => d.textContent)).toEqual(["-b\n", "+B\n"]);
  });

  it("summarizes reads and writes by size instead of previewing file contents", () => {
    const [read, write] = render([
      tool({ name: "Read", action: "read", summary: "src/a.ts", input: { path: "src/a.ts" }, result: { text: "1\n2\n3\n4\n5" } }),
      tool({ name: "Write", action: "write", summary: "src/b.ts", input: { path: "src/b.ts", content: "x\ny" }, result: { text: "ok" } }),
    ]);
    expect(read!.querySelector(".tmeta")?.textContent).toBe("5 lines");
    expect(read!.querySelector(".tprev")).toBeNull();
    expect(write!.querySelector(".tmeta")?.textContent).toBe("2 lines");
  });

  it("marks failed calls and shows more of their output", () => {
    const [entry] = render([tool({ summary: "npm test", isError: true, result: { text: "1\n2\n3\n4\n5\n6", isError: true } })]);
    expect(entry!.classList.contains("is-error")).toBe(true);
    expect(entry!.querySelector(".tstat")?.textContent).toBe("error");
    expect(entry!.querySelector(".tprev pre")?.textContent?.split("\n")).toHaveLength(6);
  });

  it("groups calls as count badges, without a count on single calls", () => {
    const [group] = render([
      {
        kind: "toolGroup",
        id: "g",
        calls: [
          { name: "Bash", count: 3, errors: 1 },
          { name: "Edit", count: 1, errors: 0 },
        ],
        total: 4,
        files: { read: [], edited: ["~/work/app/src/a.ts"], written: [] },
        commands: ["npm test"],
        responseIds: [],
      },
    ]);
    const chips = Array.from(group!.querySelectorAll(".chip"), (c) => c.textContent);
    expect(chips).toEqual(["Bash(npm)", "Bash×2", "Bash errors×1", "Edit"]);
    expect(group!.querySelector(".chip.is-error")?.textContent).toBe("Bash errors×1");
    expect(group!.querySelector(".tprev pre")?.textContent).toBe("~ src/a.ts\n$ npm test");
  });

  it("names shell calls by program in group chips and the outline", () => {
    const shell = (id: string, command: string): Step => tool({ id, summary: command, input: { command } });
    const group: Step = {
      kind: "toolGroup",
      id: "g",
      calls: [{ name: "Bash", count: 3, errors: 0 }],
      total: 3,
      files: { read: [], edited: [], written: [] },
      commands: ["git status", "git diff", "ls"],
      responseIds: [],
    };
    const [chips] = render([group]);
    expect(Array.from(chips!.querySelectorAll(".chip"), (c) => c.textContent)).toEqual(["Bash(git)×2", "Bash(ls)"]);

    const full = renderTranscript(session([turn(0, [shell("a", "git status"), shell("b", "cd app && git diff"), shell("c", "ls -la"), tool({ id: "d", name: "Edit", action: "edit", summary: "a.ts" })])]));
    expect(full.turns[0]!.items.map((i) => i.label)).toEqual(["Bash(git) ×2 · Bash(ls) · Edit"]);
    expect(full.turns[0]!.tools).toBe(4);
    const brief = renderTranscript(session([turn(0, [group])]));
    expect(brief.turns[0]!.items.map((i) => i.label)).toEqual(["Bash(git) ×2 · Bash(ls)"]);
    expect(brief.turns[0]!.tools).toBe(3);
  });

  it("shows thinking in full when the variant asks for it", () => {
    const thinking: Step = { kind: "thinking", id: "k", text: "Check the **schema** first.", chars: 26, blocks: 1 };
    const collapsed = renderTranscript(session([turn(0, [thinking])])).el.querySelector(".k-think")!;
    expect(collapsed.querySelector(".md")).toBeNull();
    const inline = renderTranscript(session([turn(0, [thinking])]), { inlineThinking: true }).el.querySelector(".k-think")!;
    expect(inline.querySelector(".md strong")?.textContent).toBe("schema");
  });
});

describe("header mode switch", () => {
  const controls = (view: ShareMode, sharedMode: ShareMode = "full") => ({
    sharedMode,
    view,
    setView: vi.fn(),
    toggleTheme: () => {},
    toggleRail: () => {},
    settings: { current: () => VARIANTS[0]!, onPick: () => {}, defaults: () => ({ canSave: false, canReset: false }), saveDefault: () => {}, resetDefault: () => {} },
    share: { source: { kind: "local" as const, name: "s.json" }, view: () => ({ ui: "", label: "" }), turn: () => undefined },
    local: false,
  });
  afterEach(() => { closeMenus(); document.body.replaceChildren(); });
  const rows = () => Array.from(document.querySelectorAll<HTMLButtonElement>(".menu-item"));
  const buttons = (el: HTMLElement) => {
    document.body.append(el);
    el.querySelector<HTMLButtonElement>(".mode-select")!.click();
    return Object.fromEntries(rows().map((b) => [b.querySelector(".menu-label")!.textContent, b.disabled]));
  };

  // Regression: the switch read the modes on offer from the projected session, so once a
  // full share was viewed as brief, "full" was disabled and there was no way back.
  it("keeps every mode the share allows on offer while viewing a smaller one", () => {
    const shared = session([turn(0, [])]);
    for (const view of ["brief", "minimal", "prompts"] as const) {
      const el = renderHeader(projectSession(shared, view), undefined, controls(view));
      expect(buttons(el)).toEqual({ full: false, brief: false, minimal: false, prompts: false });
      expect(el.querySelector(".mode-select")!.getAttribute("aria-label")).toBe(`View mode: ${view}`);
      expect(rows().find((b) => b.getAttribute("aria-checked") === "true")!.querySelector(".menu-label")!.textContent).toBe(view);
      expect(el.querySelector(".facts-share dd")?.textContent).toBe("full");
    }
  });

  it("keeps modes that weren't published unavailable", () => {
    const el = renderHeader(projectSession(session([turn(0, [])]), "brief"), undefined, controls("minimal", "brief"));
    expect(buttons(el)).toEqual({ full: true, brief: false, minimal: false, prompts: false });
    expect(rows()[0]!.querySelector(".menu-blurb")!.textContent).toBe("Shared as brief; full detail was not published");
  });

  it("allows only prompts on a prompts-only share", () => {
    const el = renderHeader(projectSession(session([turn(0, [])]), "prompts"), undefined, controls("prompts", "prompts"));
    expect(buttons(el)).toEqual({ full: true, brief: true, minimal: true, prompts: false });
    expect(document.activeElement).toBe(rows()[3]);
  });

  it("disables prompts when the stored pi user text has no verified authored input", () => {
    const c = { ...controls("full"), promptsUnavailable: "No verified pre-expansion input; private template instructions may be stored as user text." };
    const el = renderHeader(session([turn(0, [])]), undefined, c);
    expect(buttons(el)).toEqual({ full: false, brief: false, minimal: false, prompts: true });
    expect(rows()[3]!.querySelector(".menu-blurb")!.textContent).toBe(c.promptsUnavailable);
    rows()[3]!.click();
    expect(c.setView).not.toHaveBeenCalled();
  });

  it("selects a mode, closes the menu and restores trigger focus", () => {
    const c = controls("full");
    const el = renderHeader(session([turn(0, [])]), undefined, c);
    buttons(el);
    rows()[3]!.click();
    expect(c.setView).toHaveBeenCalledWith("prompts");
    expect(document.querySelector(".menu")).toBeNull();
    expect(document.activeElement).toBe(el.querySelector(".mode-select"));
  });

  it("opens with the keyboard, skips unavailable rows and closes with Escape", () => {
    const el = renderHeader(session([turn(0, [])]), undefined, controls("brief", "brief"));
    document.body.append(el);
    const button = el.querySelector<HTMLButtonElement>(".mode-select")!;
    button.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(button.getAttribute("aria-expanded")).toBe("true");
    const menu = document.querySelector(".menu")!;
    expect(document.activeElement).toBe(rows()[1]);
    for (const [key, index] of [["ArrowUp", 3], ["Home", 1], ["End", 3], ["ArrowDown", 1]] as const) {
      menu.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
      expect(document.activeElement).toBe(rows()[index]);
    }
    menu.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(button);
  });
});

describe("prompts view", () => {
  it("renders only prompts and a numeric, non-interactive summary, without a second token footer", () => {
    const full = session([turn(0, [
      { kind: "text", id: "text", text: "private reply" },
      { kind: "thinking", id: "think", text: "private reasoning", chars: 17, blocks: 1 },
      { kind: "tool", id: "read", name: "Read", action: "read", summary: "private.ts", files: ["private.ts"] },
      { kind: "tool", id: "edit", name: "Edit", action: "edit", summary: "private.ts", files: ["private.ts"] },
    ], "Fix the login")], [{ id: "r", turn: 0, usage: { ...usage(100, 840), reasoning: 320 } }]);
    const { el, turns } = renderTranscript(projectSession(full, "prompts"));
    expect(el.querySelector(".activity-summary")!.textContent).toBe("2 tool calls · 1 file read · 1 file edited · thinking 320 tokens · output 840 tokens");
    expect(el.querySelector(".k-user")!.textContent).toContain("Fix the login");
    expect(el.querySelectorAll("button, details, [aria-expanded], .turn-foot, .k-text, .k-think, .k-tool")).toHaveLength(0);
    expect(el.textContent).not.toContain("private");
    expect(turns[0]).toMatchObject({ tools: 2, errors: 0, items: [], calls: [] });
  });

  it("keeps a thinking-only turn, suppresses zero/unknown metrics and preserves work before the first prompt", () => {
    const full = session([
      { index: 0, steps: [{ kind: "tool", id: "pre", name: "Bash", action: "exec", summary: "private command", isError: true }] },
      turn(1, [{ kind: "thinking", id: "k", chars: 10, blocks: 1, text: "hidden" }]),
      turn(2, []),
    ], [{ id: "r", turn: 1, usage: { ...usage(100, 10), reasoning: 10 } }]);
    const { el, turns } = renderTranscript(projectSession(full, "prompts"));
    expect(turns.map((t) => t.ordinal)).toEqual([0, 1, 2]);
    expect(Array.from(el.querySelectorAll(".activity-summary"), (e) => e.textContent)).toEqual(["1 tool call · 1 tool error", "thinking 10 tokens · output 10 tokens"]);
    expect(el.querySelector("#turn-2 .activity-summary")).toBeNull();
    expect(el.textContent).not.toContain("thinking 0 tokens");
    expect(el.textContent).not.toContain("output 0 tokens");
    expect(el.textContent).not.toContain("private command");
  });
});

describe("outline labels", () => {
  it("caps a command's label like a prompt's: its arguments can be a whole document", () => {
    const args = "spec ".repeat(1000);
    const { turns } = renderTranscript(session([{ index: 0, user: { text: `/implement ${args}`, command: { name: "/implement", args } }, steps: [] }]));
    expect(turns[0]!.label.length).toBeLessThanOrEqual(140);
    expect(turns[0]!.label.startsWith("/implement spec spec")).toBe(true);
  });
});

describe("cost and usage scope", () => {
  const priced = (cost: number, extra: Partial<Usage> = {}): Usage => ({ ...usage(1_000, 50), cost, ...extra });
  const withStats = (s: NormalizedSession, stats: Partial<NormalizedSession["stats"]>): NormalizedSession => ({ ...s, stats: { ...s.stats, ...stats } });
  const railRows = (s: NormalizedSession) => {
    const { turns } = renderTranscript(s);
    const rail = renderTokenRail(s, turns, () => {});
    return { rail, rows: Object.fromEntries(Array.from(rail.el.querySelectorAll(".rail-sec:first-child .kv dt"), (dt) => [dt.textContent, dt.nextElementSibling?.textContent])) };
  };
  const base = () => session([turn(0, [{ kind: "text", id: "a", text: "hi" }])], [{ id: "r0", turn: 0, usage: priced(0.5) }]);

  it("labels the cost an estimate and marks a lower bound", () => {
    const s = withStats(base(), { cost: 12.4, costSource: "estimated", responses: 1 });
    expect(railRows(s).rows["est. cost"]).toBe("$12.40");
    expect(railRows(withStats(s, { costPartial: true })).rows["est. cost"]).toBe("$12.40+");
    expect("cost" in railRows(base()).rows).toBe(false);
  });

  it("shows spend on other branches and inherited history only when there is some", () => {
    const totals = { responses: 3, tokens: { input: 10, output: 20, cacheRead: 1_000, cacheWrite: 0, reasoning: 0 }, cost: 0.25 };
    expect(railRows(base()).rows["other branches"]).toBeUndefined();
    expect(railRows(base()).rows.inherited).toBeUndefined();
    const s = withStats(base(), { otherBranches: totals, inherited: { ...totals, cost: 1.5 } });
    expect(railRows(s).rows["other branches"]).toBe("$0.250 · 3 calls");
    expect(railRows(s).rows.inherited).toBe("$1.50 · 3 calls");
  });

  it("draws inherited turns muted and leaves them out of the running totals", () => {
    const s = session(
      [turn(0, [{ kind: "text", id: "a", text: "parent" }]), turn(1, [{ kind: "text", id: "b", text: "child" }])],
      [
        { id: "r0", turn: 0, usage: priced(1), inherited: true },
        { id: "r1", turn: 1, usage: priced(0.5) },
      ],
    );
    const { turns } = renderTranscript(s);
    const rail = renderTokenRail(s, turns, () => {});
    const muted = () => Array.from(rail.el.querySelectorAll(".rail-sec .cols:not(.cols-out) .col"), (c) => c.classList.contains("inh"));
    expect(muted()).toEqual([true, false]);
    rail.setActive(0);
    expect(rail.el.querySelector(".rail-turn")!.textContent).toContain("parent session (not counted)");
    expect(rail.el.querySelector(".rail-turn")!.textContent).not.toContain("so far");
    rail.setActive(1);
    // Only the child's own call counts: 1.0k context + 50 output, $0.500.
    expect(rail.el.querySelector(".rail-turn")!.textContent).toContain("1.1k · $0.500");
    const foot = renderTranscript(s).el.querySelectorAll(".turn-foot");
    expect(foot[0]!.textContent).toContain("inherited from parent session");
    expect(foot[1]!.textContent).toContain("$0.500");
  });

  it("counts only a mixed turn's own calls (a fork continued mid-turn)", () => {
    const s = session([turn(0, [{ kind: "text", id: "a", text: "parent then child" }])], [
      { id: "r0", turn: 0, usage: priced(1), inherited: true },
      { id: "r1", turn: 0, usage: priced(0.5) },
    ]);
    const { turns, el } = renderTranscript(s);
    const rail = renderTokenRail(s, turns, () => {});
    rail.setActive(0);
    const box = rail.el.querySelector(".rail-turn")!.textContent!;
    expect(box).toContain("$0.500");
    expect(box).not.toContain("$1.50");
    expect(box).toContain("1 call from parent (not counted)");
    expect(el.querySelector(".turn-foot")!.textContent).toContain("2 model calls");
    expect(el.querySelector(".turn-foot")!.textContent).toContain("$0.500");
    expect(el.querySelector(".turn-foot")!.textContent).toContain("1 inherited");
  });

  it("names the purpose of calls the harness made itself", () => {
    const s = session([turn(0, [{ kind: "text", id: "a", text: "hi" }])], [{ id: "c", turn: 0, usage: priced(0.01), purpose: "compaction" }]);
    const { turns } = renderTranscript(s);
    const rail = renderTokenRail(s, turns, () => {});
    rail.setActive(0);
    document.body.innerHTML = '<div id="tooltip" class="tooltip" hidden></div>';
    const col = rail.el.querySelector<HTMLElement>(".rail-turn .cols:not(.cols-out) .col")!;
    col.dispatchEvent(new PointerEvent("pointerenter", { clientX: 5, clientY: 5 }));
    expect(document.querySelector(".tooltip")?.textContent).toContain("compaction");
    document.body.replaceChildren();
  });

  it("renders shares made before costs were estimated", () => {
    const old = withStats(base(), { cost: 16.96, costSource: "session-total" });
    expect(railRows(old).rows["est. cost"]).toBe("$16.96");
  });
});
