// @vitest-environment jsdom
/** What the transcript and token rail render for the session data they're given. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { SCHEMA_VERSION, type NormalizedSession, type ShareMode, type Step, type Turn, type Usage } from "../src/schema.ts";

(globalThis as { __OVERSHARE_SOURCES__?: Record<string, string> }).__OVERSHARE_SOURCES__ = {};
const { renderTranscript } = await import("../viewer/src/transcript.ts");
const { renderTokenRail } = await import("../viewer/src/tokens.ts");
const { renderHeader } = await import("../viewer/src/header.ts");
const { closeHoverCard } = await import("../viewer/src/popover.ts");
const { setCardView } = await import("../viewer/src/turncard.ts");
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

/** Two calls in one turn: the first thinks and runs a command, the second replies. */
const twoCalls = () =>
  session(
    [
      turn(0, [
        { kind: "thinking", id: "t", text: "Check the tests first", chars: 21, blocks: 1, responseId: "r0" },
        { kind: "tool", id: "b", name: "Bash", action: "exec", summary: "npm test", input: { command: "npm test" }, result: { text: "1 failed", isError: true }, isError: true, responseId: "r0" },
        { kind: "text", id: "x", text: "**One** test fails.", responseId: "r1" },
      ]),
    ],
    [
      { id: "r0", turn: 0, usage: { input: 200, output: 40, cacheRead: 3_000, cacheWrite: 800, reasoning: 10 } },
      { id: "r1", turn: 0, usage: usage(4_000, 90) },
    ],
  );

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

describe("subagent step line", () => {
  const sub = (usage: Extract<Step, { kind: "subagent" }>["usage"]): Step => ({ kind: "subagent", id: "s", tool: "Agent", agents: ["scout"], description: "find it", usage }) as Step;
  const chip = (usage: Extract<Step, { kind: "subagent" }>["usage"]) => {
    const { el } = renderTranscript(session([turn(0, [sub(usage)])]));
    return el.querySelector(".entry.k-sub .tmeta")?.textContent;
  };

  it("shows the subagent's total: tokens, model calls, tool calls, time and cost", () => {
    expect(chip({ totalTokens: 26_921, turns: 2, toolUses: 1, durationMs: 6_000, cost: 0.0215 })).toBe("26.9k tokens · 2 model calls · 1 tool call · 6s · $0.021");
  });

  it("leaves pi's best-effort chip as it was", () => {
    expect(chip({ totalTokens: 14_419, toolUses: 1 })).toBe("14.4k tokens · 1 tool call");
  });

  it("shows only counts when the adapter reported no tokens", () => {
    expect(chip({ toolUses: 7, durationMs: 9_000 })).toBe("7 tool calls · 9s");
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

  it("draws a mixed turn's card from every call, like its bar, and charges only its own", () => {
    document.body.innerHTML = '<div id="tooltip" class="tooltip" hidden></div>';
    const s = session([turn(0, [{ kind: "text", id: "a", text: "parent then child" }])], [
      { id: "r0", turn: 0, usage: priced(1, { output: 300 }), inherited: true },
      { id: "r1", turn: 0, usage: priced(0.5, { output: 200 }) },
    ]);
    const { turns } = renderTranscript(s);
    const rail = renderTokenRail(s, turns, () => {});
    document.body.append(rail.el);
    const col = rail.el.querySelector<HTMLElement>(".rail-sec .cols:not(.cols-out) .col")!;
    col.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    const card = document.querySelector<HTMLElement>(".hcard")!;
    const output = Array.from(card.querySelectorAll(".cc-row"), (r) => r.textContent!).find((t) => t.startsWith("output"));
    expect(output).toBe("output500"); // what the bar draws: both calls' output
    expect(card.querySelector(".hc-count")!.textContent).toBe("$0.500");
    expect(card.textContent).toContain("1 call from parent (cost not counted)");
    closeHoverCard();
    document.body.replaceChildren();
  });

  /** The card of the in-view turn's `i`th call bar, opened from the keyboard. */
  const openCall = (rail: { el: HTMLElement }, i = 0) => {
    closeHoverCard();
    rail.el.querySelectorAll<HTMLElement>(".rail-turn .cols:not(.cols-out) .col")[i]!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    return document.querySelector<HTMLElement>(".hcard")!;
  };

  it("names the purpose of calls the harness made itself, and leaves them out of the flow", () => {
    const s = session([turn(0, [{ kind: "text", id: "a", text: "hi" }])], [{ id: "c", turn: 0, usage: priced(0.01), purpose: "compaction" }]);
    const { turns } = renderTranscript(s);
    const rail = renderTokenRail(s, turns, () => {});
    rail.setActive(0);
    document.body.replaceChildren(rail.el);
    const card = openCall(rail);
    expect(card.querySelector(".cc-sub")!.textContent).toContain("compaction");
    expect(card.textContent).toContain("Made outside the conversation");
    expect(card.querySelector(".tc-io")).toBeNull();
    closeHoverCard();
    document.body.replaceChildren();
  });

  // Regression: a share is untrusted, and a tool group without a usable list of calls used to stop the whole session loading.
  it("still renders the rail when a tool group's response ids are not a list", () => {
    const group = { kind: "toolGroup", id: "g", calls: [{ name: "Read", count: 1, errors: 0 }], total: 1, files: { read: [], edited: [], written: [] }, commands: [], responseIds: null } as unknown as Step;
    const s = { ...session([turn(0, [group])], [{ id: "r0", turn: 0, usage: usage(1_000, 50) }]), mode: "brief" as const };
    const { turns } = renderTranscript(s);
    // The transcript shows that turn as a placeholder; the rail must still render around it.
    const rail = renderTokenRail(s, turns, () => {}, () => {});
    expect(() => rail.setActive(0)).not.toThrow();
    expect(rail.el.querySelector(".rail-sec h3")!.textContent).toBe("Session");
  });

  // Regression (ove-irp5): the rail's shell breakdown read a tool group's calls and commands unchecked.
  it.each<[string, Record<string, unknown>]>([
    ["calls is null", { calls: null }],
    ["calls is a number", { calls: 5 }],
    ["calls is a string", { calls: "Bash" }],
    ["calls is an object", { calls: {} }],
    ["calls holds a non-object", { calls: [null] }],
    ["commands is null", { commands: null }],
    ["commands holds a non-string", { commands: [null, 5] }],
  ])("still renders the session when a tool group's %s", (_, broken) => {
    const bad = { kind: "toolGroup", id: "g", calls: [{ name: "Bash", count: 2, errors: 0 }], total: 2, files: { read: [], edited: [], written: [] }, commands: ["npm test", "git status"], responseIds: ["r0"], ...broken } as unknown as Step;
    const good: Step = { kind: "tool", id: "t", name: "Bash", action: "exec", summary: "npm run build", input: { command: "npm run build" }, responseId: "r1" };
    const base = session([turn(0, [bad]), turn(1, [good])], [
      { id: "r0", turn: 0, usage: usage(1_000, 50) },
      { id: "r1", turn: 1, usage: usage(2_000, 50) },
    ]);
    const s = { ...base, mode: "brief" as const, stats: { ...base.stats, toolCalls: 3, tools: { Bash: 3 } } };
    const { el, turns } = renderTranscript(s);
    const rail = renderTokenRail(s, turns, () => {}, () => {});
    rail.setActive(1);
    // The transcript shows the broken turn as its placeholder and the other turn as usual.
    expect(el.querySelector("#turn-0 .k-unsupported")!.textContent).toContain("couldn't be shown");
    expect(el.querySelector("#turn-1 .k-unsupported")).toBeNull();
    // The rail keeps the session's Bash total; the readable step's program is named and the
    // unreadable group's two calls, which can't be attributed, show as "other".
    const rows = Array.from(rail.el.querySelectorAll(".bars-row"), (r) => [r.querySelector(".bars-name")!.textContent, r.querySelector(".bars-n")!.textContent]);
    expect(rows).toEqual([["Bash", "3"], ["npm", "1"], ["other", "2"]]);
  });

  it("says a step couldn't be shown in a model call's card instead of dropping the card", () => {
    document.body.innerHTML = '<div id="tooltip" class="tooltip" hidden></div>';
    const s = session([turn(0, [{ kind: "thinking", id: "t", text: 5, chars: 3, blocks: 1, responseId: "r0" } as unknown as Step])], [{ id: "r0", turn: 0, usage: usage(1_000, 50) }]);
    const { turns } = renderTranscript(s);
    const rail = renderTokenRail(s, turns, () => {}, () => {});
    rail.setActive(0);
    document.body.replaceChildren(rail.el);
    const card = openCall(rail);
    expect(Array.from(card.querySelectorAll(".cb-line"), (l) => l.textContent)).toEqual(["?couldn't be shown"]);
    closeHoverCard();
    document.body.replaceChildren();
  });

  it("goes to the first step a model call produced when its bar is clicked", () => {
    const s = twoCalls();
    const { turns } = renderTranscript(s);
    const steps: string[] = [];
    const rail = renderTokenRail(s, turns, () => {}, (id) => steps.push(id));
    rail.setActive(0);
    const [first, second] = rail.el.querySelectorAll<HTMLElement>(".rail-turn .cols:not(.cols-out) .col");
    first!.click();
    second!.click();
    // The output bar below goes to the same place.
    rail.el.querySelectorAll<HTMLElement>(".rail-turn .cols-out .col")[1]!.click();
    expect(steps).toEqual(["s-0-0", "s-0-2", "s-0-2"]);
  });

  it("leaves call bars unclickable where there is no step to go to", () => {
    const s = twoCalls();
    const { turns } = renderTranscript(s);
    const rail = renderTokenRail(s, turns, () => {});
    rail.setActive(0);
    expect(rail.el.querySelector(".rail-turn .cols:not(.cols-out) button.col")).toBeNull();
  });

  it("shows a model call's split, output and every step it produced, each going to its step", () => {
    const s = twoCalls();
    const { turns } = renderTranscript(s);
    const steps: string[] = [];
    const rail = renderTokenRail(s, turns, () => {}, (id) => steps.push(id));
    rail.setActive(0);
    document.body.replaceChildren(rail.el);
    let card = openCall(rail);
    expect(card.querySelector(".cc-title")!.textContent).toBe("Model call 1 of 2");
    const rows = Array.from(card.querySelectorAll(".cc-row"), (r) => Array.from(r.children, (c) => c.textContent).slice(1).join("|"));
    expect(rows).toEqual(["cache read|3.0k|75%", "cache write|800|20%", "uncached input|200|5%", "output (10 thinking)|40|"]);
    const acts = Array.from(card.querySelectorAll(".cb-line"), (a) => [a.querySelector(".cb-what")!.textContent, a.querySelector(".hc-text")!.textContent, a.classList.contains("is-error")]);
    expect(acts).toEqual([["thinking", "Check the tests first", false], ["Bash", "npm test", true]]);
    expect(card.querySelector(".cc-hint")!.textContent).toBe("Click a line to go to that step");
    card.querySelectorAll<HTMLElement>(".cb-line")[1]!.click();
    expect(steps).toEqual(["s-0-1"]);
    // The second call's card has only its own reply, as plain text.
    card = openCall(rail, 1);
    expect(card.querySelector(".cb-line .hc-text")!.textContent).toBe("One test fails.");
    closeHoverCard();
    document.body.replaceChildren();
  });

  it("shows a turn's prompt, its calls and its tool calls in the context-by-turn card", () => {
    document.body.innerHTML = '<div id="tooltip" class="tooltip" hidden></div>';
    const s = twoCalls();
    const { turns } = renderTranscript(s);
    const jumps: number[] = [];
    const rail = renderTokenRail(s, turns, (t) => jumps.push(t));
    document.body.append(rail.el);
    const col = rail.el.querySelector<HTMLElement>(".rail-sec .cols:not(.cols-out) .col")!;
    col.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    const card = document.querySelector<HTMLElement>(".hcard")!;
    expect(card.querySelector(".hc-title")!.textContent).toBe("Turn 1");
    expect(card.querySelector(".cb-label")!.textContent).toBe("“prompt 0”");
    expect(card.querySelector(".cc-total")!.textContent).toBe("peak context4.0k");
    expect(card.querySelector(".cb-facts.tc-pad")!.textContent).toBe("2 calls · 1 tool (1 failed)");
    // No per-call chart: the lines below list the calls.
    expect(card.querySelector(".cc-spark")).toBeNull();
    expect(Array.from(card.querySelectorAll(".cb-line .cb-what"), (w) => w.textContent)).toEqual(["Bash", "reply"]);
    closeHoverCard();
    col.click();
    expect(jumps).toEqual([0]);
    document.body.replaceChildren();
  });
});

describe("turn cards", () => {
  afterEach(() => {
    closeHoverCard();
    setCardView("ledger");
    document.body.replaceChildren();
  });

  /** 100 turns (merged two to a bar); turn 1 makes seven calls, the first a failing Bash call. Each call writes a little more. */
  const many = () => {
    const turns: Turn[] = [];
    const responses: NormalizedSession["responses"] = [];
    for (let i = 0; i < 100; i++) {
      const steps: Step[] = [];
      const calls = i === 1 ? 7 : 1;
      for (let c = 0; c < calls; c++) {
        const id = `r${i}-${c}`;
        steps.push(
          c === 0 && i === 1
            ? { kind: "tool", id: `b${i}`, name: "Bash", action: "exec", summary: "npm test", input: { command: "npm test" }, result: { text: "1 failed", isError: true }, isError: true, responseId: id }
            : { kind: "text", id: `x${i}-${c}`, text: `reply ${i}.${c}`, responseId: id },
        );
        responses.push({ id, turn: i, usage: { input: 0, output: 10, cacheRead: 1_000 * (i + 1), cacheWrite: 100 * (c + 1), reasoning: 0 } });
      }
      turns.push(turn(i, steps, `prompt ${i}`));
    }
    return session(turns, responses);
  };

  /** Turn 0: a call that reads two files at once, then one that replies. */
  const batched = () =>
    session(
      [
        turn(0, [
          { kind: "tool", id: "a", name: "Read", action: "read", summary: "src/a.ts", input: { file_path: "src/a.ts" }, responseId: "r0" },
          { kind: "tool", id: "b", name: "Read", action: "read", summary: "src/b.ts", input: { file_path: "src/b.ts" }, responseId: "r0" },
          { kind: "text", id: "x", text: "Both read.", responseId: "r1" },
        ]),
      ],
      [
        { id: "r0", turn: 0, usage: { input: 5, output: 30, cacheRead: 2_000, cacheWrite: 400, reasoning: 0 } },
        { id: "r1", turn: 0, usage: { input: 3, output: 60, cacheRead: 2_405, cacheWrite: 6_000, reasoning: 0 } },
      ],
    );

  const mount = (s: NormalizedSession, onJump: (t: number) => void = () => {}, onJumpTo: (id: string) => void = () => {}) => {
    const { turns } = renderTranscript(s);
    const rail = renderTokenRail(s, turns, onJump, onJumpTo);
    document.body.innerHTML = '<div id="tooltip" class="tooltip" hidden></div>';
    document.body.append(rail.el);
    return rail;
  };
  const open = (rail: { el: HTMLElement }, i = 0) => {
    const col = rail.el.querySelectorAll<HTMLElement>(".rail-sec .cols:not(.cols-out) .col")[i]!;
    col.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    return { col, card: document.querySelector<HTMLElement>(".hcard")! };
  };
  const tableRows = (card: HTMLElement) => Array.from(card.querySelectorAll(".tc-row:not(.tc-headrow)"), (r) => Array.from(r.children, (c) => c.textContent).join("|"));

  it("opens a merged bar's card with a section per turn: its prompt, figures and model calls", () => {
    const { col, card } = open(mount(many()));
    expect(col.getAttribute("aria-expanded")).toBe("true");
    expect(card.querySelector(".hc-title")!.textContent).toBe("Turn 1 – Turn 2");
    expect(card.querySelector(".hc-count")!.textContent).toBe("2 turns");
    expect(card.querySelector(".tc-overview")!.textContent).toBe("2.7k peak context · +2.9k added · 80 out");
    const entries = Array.from(card.querySelectorAll(".tc-unit"));
    expect(entries.map((e) => e.querySelector(".cb-name")!.textContent)).toEqual(["Turn 1", "Turn 2"]);
    expect(entries.map((e) => e.querySelector(".cb-label")!.textContent)).toEqual(["“prompt 0”", "“prompt 1”"]);
    expect(entries[1]!.querySelector(".cb-facts")!.textContent).toBe("7 calls · 1 tool (1 failed)");
    // One line per call, with its size and what it did; capped, and the rest counted.
    const lines = Array.from(entries[1]!.querySelectorAll(".cb-line"), (l) => [l.querySelector(".cb-ctx")!.textContent, l.querySelector(".cb-what")!.textContent, l.querySelector(".hc-text")!.textContent, l.classList.contains("is-error")]);
    expect(lines).toEqual([
      ["2.1k", "Bash", "npm test", true],
      ["2.2k", "reply", "reply 1.1", false],
      ["2.3k", "reply", "reply 1.2", false],
      ["2.4k", "reply", "reply 1.3", false],
      ["2.5k", "reply", "reply 1.4", false],
    ]);
    expect(entries[1]!.querySelector(".cb-more")!.textContent).toBe("+2 more calls");
    // Each turn's largest prompt is drawn against the larger of the two.
    expect(entries[1]!.querySelector<HTMLElement>(".cb-bar")!.style.width).toBe("100%");
  });

  it("goes to a turn from its heading and to a model call from its line, closing the card", () => {
    const jumps: number[] = [];
    const steps: string[] = [];
    const rail = mount(many(), (t) => jumps.push(t), (id) => steps.push(id));
    open(rail).card.querySelectorAll<HTMLElement>(".cb-head")[1]!.click();
    expect(jumps).toEqual([1]);
    expect(document.querySelector(".hcard")).toBeNull();
    open(rail).card.querySelectorAll<HTMLElement>(".tc-unit")[1]!.querySelectorAll<HTMLElement>(".cb-line")[2]!.click();
    expect(steps).toEqual(["s-1-2"]);
    expect(document.querySelector(".hcard")).toBeNull();
  });

  it("is reached from the keyboard: Enter opens it on the first turn, arrows walk turns and calls", () => {
    const { card } = open(mount(many()));
    const items = Array.from(card.querySelectorAll<HTMLElement>("[data-hc-item]"));
    expect(document.activeElement).toBe(items[0]);
    expect(items[0]!.classList.contains("cb-head")).toBe(true);
    items[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(document.activeElement).toBe(items[1]);
    expect(items[1]!.classList.contains("cb-line")).toBe(true);
  });

  it("switches views from its tabs, and opens the next card in the view last picked", () => {
    const rail = mount(many());
    let { card } = open(rail);
    const tabs = () => Array.from(card.querySelectorAll<HTMLElement>(".tc-tab"), (t) => [t.textContent, t.getAttribute("aria-selected")]);
    expect(tabs()).toEqual([["ledger", "true"], ["table", "false"], ["waterfall", "false"], ["bar", "false"]]);
    expect(card.querySelector<HTMLElement>(".tc-foot")!.hidden).toBe(true);
    card.querySelectorAll<HTMLElement>(".tc-tab")[1]!.click();
    expect(tabs()[1]).toEqual(["table", "true"]);
    expect(card.querySelector(".tc-table")).not.toBeNull();
    // The views that credit sources say how, in a line under the list.
    expect(card.querySelector<HTMLElement>(".tc-foot")!.hidden).toBe(false);
    closeHoverCard();
    card = open(rail, 1).card;
    expect(card.querySelector(".tc-table")).not.toBeNull();
    // Arrow keys step through the tabs.
    card.querySelector(".tc-views")!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(card.querySelector(".tc-wf")).not.toBeNull();
    expect(document.activeElement?.textContent).toBe("waterfall");
  });

  it("credits your prompt and each call with what it added to the next prompt, in the table", () => {
    setCardView("table");
    const { card } = open(mount(twoCalls()));
    // Turn 1's calls: the first sent 3.0k read + 800 written + 200 input, the second 4.0k read.
    expect(tableRows(card)).toEqual([
      "you prompt 0|4.0k|+800|+200|",
      "Bash npm test|4.0k|–|–|40",
      "reply One test fails.|→|||90",
      "turn|4.0k|+800|+200|130",
    ]);
    expect(card.querySelector(".tc-callrow")!.classList.contains("is-error")).toBe(true);
  });

  it("gives tool calls made at once one row, with each listed under it and going to its own step", () => {
    setCardView("table");
    const steps: string[] = [];
    const { card } = open(mount(batched(), () => {}, (id) => steps.push(id)));
    expect(tableRows(card)).toEqual([
      "you prompt 0|2.4k|+400|+5|",
      "Read ×2 2 at once|8.4k|+6.0k|+3|30",
      "Read src/a.ts",
      "Read src/b.ts",
      "reply Both read.|→|||60",
      "turn|8.4k|+6.4k|+8|90",
    ]);
    card.querySelectorAll<HTMLElement>(".tc-subrow")[1]!.click();
    expect(steps).toEqual(["s-0-1"]);
  });

  it("draws each source's piece under the part of the turn's bar it added, and lights it up on hover", () => {
    setCardView("waterfall");
    const { card } = open(mount(batched()));
    expect(card.querySelector(".tc-wf-total")!.textContent).toBe("2.0k → 8.4k+6.4k");
    const rows = Array.from(card.querySelectorAll<HTMLElement>(".tc-wf-row"));
    expect(rows.map((r) => [r.querySelector(".cb-ctx")!.textContent, r.querySelector(".cb-what")!.textContent])).toEqual([["+405", "you"], ["+6.0k", "Read ×2"], ["→", "reply"]]);
    const piece = (i: number) => rows[i]!.querySelector<HTMLElement>(".tc-piece")!.style;
    expect([piece(0).left, piece(1).left]).toEqual(["0%", `${(405 / 6_408) * 100}%`]);
    rows[1]!.dispatchEvent(new MouseEvent("pointerover", { bubbles: true }));
    expect(card.querySelector(".tc-wf")!.classList.contains("is-lit")).toBe(true);
    expect(Array.from(card.querySelectorAll(".tc-grp.lit"), (g) => (g as HTMLElement).dataset.src)).toEqual(["0-0"]);
  });

  it("names a wide enough source inside the bar and every source as a chip", () => {
    setCardView("bar");
    const { card } = open(mount(batched()));
    expect(Array.from(card.querySelectorAll(".tc-lbl"), (l) => l.textContent)).toEqual(["Read ×2 +6.0k"]);
    expect(Array.from(card.querySelectorAll(".tc-chip"), (c) => c.textContent)).toEqual(["you+405", "Read ×2+6.0k", "reply→"]);
  });

  it("explains the view beside the card, with how sources are credited where it applies", () => {
    const { card } = open(mount(twoCalls()));
    const info = card.querySelector<HTMLElement>(".tc-info")!;
    const explain = () => {
      info.dispatchEvent(new FocusEvent("focus"));
      return document.getElementById("tooltip")!.textContent!;
    };
    expect(explain()).toContain("ledger view");
    expect(explain()).not.toContain("Shifted by one step");
    card.querySelectorAll<HTMLElement>(".tc-tab")[2]!.click();
    expect(explain()).toContain("waterfall view");
    expect(explain()).toContain("Shifted by one step");
    expect(card.querySelector(`#${info.getAttribute("aria-describedby")}`)!.textContent).toContain("Shifted by one step");
  });

  it("leaves calls outside the conversation out of the sources", () => {
    setCardView("table");
    const s = session(
      [turn(0, [{ kind: "text", id: "a", text: "first", responseId: "r0" }, { kind: "text", id: "b", text: "second", responseId: "r1" }])],
      [
        { id: "r0", turn: 0, usage: usage(1_000, 10) },
        { id: "c", turn: 0, usage: usage(50_000, 5), purpose: "compaction" },
        { id: "r1", turn: 0, usage: usage(1_200, 10) },
      ],
    );
    const { card } = open(mount(s));
    expect(tableRows(card).map((r) => r.split("|")[0])).toEqual(["you prompt 0", "reply first", "reply second", "turn"]);
  });

  it("floats a count of the turns below the fold until the list is scrolled near its end", () => {
    const { card } = open(mount(many()));
    const list = card.querySelector<HTMLElement>(".tc-list")!;
    const float = card.querySelector<HTMLElement>(".cb-float")!;
    const [one, two] = Array.from(card.querySelectorAll<HTMLElement>(".tc-unit"));
    // jsdom has no layout: the list shows 100px of 300, the second turn starts at 120px.
    Object.defineProperty(list, "clientHeight", { value: 100, configurable: true });
    Object.defineProperty(list, "scrollHeight", { value: 300, configurable: true });
    Object.defineProperty(one!, "offsetTop", { value: 0 });
    Object.defineProperty(two!, "offsetTop", { value: 120 });
    list.dispatchEvent(new Event("scroll"));
    expect(float.classList.contains("is-hidden")).toBe(false);
    expect(float.textContent).toBe("↓ 1 more turn");
    list.scrollTop = 150;
    list.dispatchEvent(new Event("scroll"));
    expect(float.textContent).toBe("↓ more below");
    list.scrollTop = 190;
    list.dispatchEvent(new Event("scroll"));
    expect(float.classList.contains("is-hidden")).toBe(true);
  });

  it("keeps the output bars out of the tab order", () => {
    const rail = mount(many());
    rail.setActive(1);
    for (const out of rail.el.querySelectorAll<HTMLElement>(".cols-out .col")) {
      expect(out.getAttribute("aria-haspopup")).toBe("true");
      expect(out.hasAttribute("tabindex")).toBe(false);
    }
  });

  /** The card of the in-view turn's `i`th call bar. */
  const openCall = (rail: { el: HTMLElement }, i = 0) => {
    closeHoverCard();
    rail.el.querySelectorAll<HTMLElement>(".rail-turn .cols:not(.cols-out) .col")[i]!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    return document.querySelector<HTMLElement>(".hcard")!;
  };

  it("shows where a call's new tokens came from and what it added to the next prompt, on one scale", () => {
    const steps: string[] = [];
    const rail = mount(batched(), () => {}, (id) => steps.push(id));
    rail.setActive(0);
    const flow = () => Array.from(document.querySelectorAll(".tc-io > *"), (c) => c.textContent);
    openCall(rail, 0);
    expect(flow()).toEqual(["in", "", "+405", "from your prompt, with the previous turn's last reply", "out", "", "+6.0k", "its output and results, into call 2"]);
    const fills = Array.from(document.querySelectorAll<HTMLElement>(".tc-io-fill"), (f) => f.style.width);
    expect(fills).toEqual([`${(405 / 6_003) * 100}%`, "100%"]);
    openCall(rail, 1);
    expect(flow()).toEqual(["in", "", "+6.0k", "from Read ×2 src/a.ts · src/b.ts · call 1", "out", "", "→", "its reply goes into the next turn"]);
    // "from" goes to the step it names.
    document.querySelector<HTMLElement>("button.tc-io-who")!.click();
    expect(steps).toEqual(["s-0-0"]);
  });

  it("lights up the bar a call's results went into while its card is open", () => {
    const rail = mount(batched());
    rail.setActive(0);
    const chart = rail.el.querySelector<HTMLElement>(".rail-turn .chart")!;
    const bars = () => Array.from(chart.querySelectorAll(".cols:not(.cols-out) .col"), (c) => (c.classList.contains("is-next") ? "next" : c.classList.contains("is-from") ? "from" : "-"));
    openCall(rail, 0);
    expect(chart.classList.contains("has-next")).toBe(true);
    expect(bars()).toEqual(["from", "next"]);
    expect(chart.querySelector(".col-tag")!.textContent).toBe("+6.0k");
    closeHoverCard();
    expect(chart.classList.contains("has-next")).toBe(false);
    expect(chart.querySelector(".col-tag")).toBeNull();
    // The last call's results go into the next turn: nothing to light.
    openCall(rail, 1);
    expect(chart.classList.contains("has-next")).toBe(false);
  });

  it("reaches the view tabs from the keyboard: Tab moves through the card, and leaving it goes back to the bar", () => {
    const rail = mount(many());
    const { col, card } = open(rail);
    const tabs = Array.from(card.querySelectorAll<HTMLElement>(".tc-tab"));
    // One stop for the tab row, the selected tab, ahead of the list in the card's order.
    expect(tabs.map((t) => t.tabIndex)).toEqual([0, -1, -1, -1]);
    const stops = Array.from(card.querySelectorAll<HTMLElement>("button, [tabindex]")).filter((el) => el.tabIndex >= 0);
    expect(stops[0]).toBe(tabs[0]);
    const tab = (from: HTMLElement, shiftKey = false) => {
      from.focus();
      from.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey, bubbles: true }));
    };
    // Within the card, Tab is left to move focus.
    tab(stops[1]!);
    expect(document.querySelector(".hcard")).not.toBeNull();
    tab(stops[1]!, true);
    expect(document.querySelector(".hcard")).not.toBeNull();
    // From the tabs, arrows switch views; the selected tab stays the stop.
    tabs[0]!.focus();
    tabs[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(document.activeElement).toBe(tabs[1]);
    expect(tabs.map((t) => t.tabIndex)).toEqual([-1, 0, -1, -1]);
    // Back past the first stop, or on past the last: the card closes and focus returns to the bar.
    tab(tabs[1]!, true);
    expect(document.querySelector(".hcard")).toBeNull();
    expect(document.activeElement).toBe(col);
    const again = open(rail).card;
    const last = Array.from(again.querySelectorAll<HTMLElement>("button, [tabindex]")).filter((el) => el.tabIndex >= 0).at(-1)!;
    tab(last);
    expect(document.querySelector(".hcard")).toBeNull();
    expect(document.activeElement).toBe(col);
  });

  /** Two calls whose provider reports no caching: every prompt is all uncached input. */
  const uncached = () =>
    session(
      [turn(0, [{ kind: "text", id: "a", text: "first", responseId: "r0" }, { kind: "text", id: "b", text: "second", responseId: "r1" }])],
      [
        { id: "r0", turn: 0, usage: { input: 9_000, output: 40, cacheRead: 0, cacheWrite: 0, reasoning: 0 } },
        { id: "r1", turn: 0, usage: { input: 9_500, output: 60, cacheRead: 0, cacheWrite: 0, reasoning: 0 } },
      ],
    );

  it("doesn't credit sources where the provider reports no caching: ledger only, and no in/out", () => {
    setCardView("table");
    const rail = mount(uncached());
    const { card } = open(rail);
    // Every prompt would count as all new: the attribution views aren't offered.
    expect(card.querySelector(".tc-views")).toBeNull();
    expect(card.querySelector(".tc-ledger")).not.toBeNull();
    expect(card.textContent).toContain("doesn't report prompt caching");
    expect(card.querySelector(".tc-overview")!.textContent).toBe("9.5k peak context · 100 out");
    rail.setActive(0);
    const call = openCall(rail, 0);
    expect(call.querySelector(".tc-io")).toBeNull();
    expect(call.textContent).toContain("doesn't report prompt caching");
    expect(rail.el.querySelector(".rail-turn .chart")!.classList.contains("has-next")).toBe(false);
  });

  it("scrolls a call's card below its title, so every step it produced can be reached", () => {
    const steps: Step[] = Array.from({ length: 24 }, (_, i) => ({ kind: "tool", id: `t${i}`, name: "Read", action: "read", summary: `src/f${i}.ts`, input: { file_path: `src/f${i}.ts` }, responseId: "r0" }) as Step);
    const rail = mount(session([turn(0, steps)], [{ id: "r0", turn: 0, usage: { input: 5, output: 30, cacheRead: 2_000, cacheWrite: 400, reasoning: 0 } }]));
    rail.setActive(0);
    const card = openCall(rail, 0);
    const list = card.querySelector(".hc-list")!;
    expect(list.querySelectorAll(".cb-line")).toHaveLength(24);
    expect(list.querySelector(".tc-io")).not.toBeNull();
    // The title stays above the list.
    expect(list.contains(card.querySelector(".cc-head"))).toBe(false);
  });

  /** One turn of 130 calls: the turn's chart merges them three to a bar. */
  const longTurn = () => {
    const steps: Step[] = [];
    const responses: NormalizedSession["responses"] = [];
    for (let c = 0; c < 130; c++) {
      steps.push({ kind: "tool", id: `t${c}`, name: "Read", action: "read", summary: `src/f${c}.ts`, input: { file_path: `src/f${c}.ts` }, responseId: `r${c}` });
      responses.push({ id: `r${c}`, turn: 0, usage: { input: 1, output: 10, cacheRead: 1_000 + c * 100, cacheWrite: 100, reasoning: 0 } });
    }
    return session([turn(0, steps)], responses);
  };

  it("opens a merged call bar in ledger, table, waterfall or calls, sharing the view picked elsewhere", () => {
    const rail = mount(longTurn());
    rail.setActive(0);
    let card = openCall(rail, 0);
    expect(card.querySelector(".hc-title")!.textContent).toBe("Calls 1–3");
    expect(Array.from(card.querySelectorAll(".tc-tab"), (t) => t.textContent)).toEqual(["ledger", "table", "waterfall", "calls"]);
    expect(card.querySelectorAll(".tc-list > .tc-unit")).toHaveLength(3);
    // The run starts the turn, so your prompt is its first source.
    card.querySelectorAll<HTMLElement>(".tc-tab")[1]!.click();
    expect(tableRows(card)).toEqual(["you prompt 0|1.1k|+100|+1|", "Read src/f0.ts|1.2k|+100|+1|10", "Read src/f1.ts|1.3k|+100|+1|10", "Read src/f2.ts|1.4k|+100|+1|10", "these calls|1.4k|+400|+4|30"]);
    // A later run has no prompt row; its last call's results go into the next run's first call.
    card = openCall(rail, 1);
    expect(card.querySelector(".tc-tab[aria-selected=true]")!.textContent).toBe("table");
    expect(tableRows(card).map((r) => r.split("|")[0])).toEqual(["Read src/f3.ts", "Read src/f4.ts", "Read src/f5.ts", "these calls"]);
    card.querySelectorAll<HTMLElement>(".tc-tab")[3]!.click();
    expect(Array.from(card.querySelectorAll(".tc-calls .cb-ctx"), (c) => c.textContent)).toEqual(["+101", "+101", "+101"]);
    // A turn card has no calls view: it opens in ledger, and the pick still holds for call cards.
    closeHoverCard();
    rail.el.querySelector<HTMLElement>(".rail-sec .cols:not(.cols-out) .col")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(document.querySelector(".hcard .tc-tab[aria-selected=true]")!.textContent).toBe("ledger");
    expect(openCall(rail, 2).querySelector(".tc-tab[aria-selected=true]")!.textContent).toBe("calls");
  });
});

describe("system prompt", () => {
  const withPrompt = (mode: ShareMode, systemPrompt: unknown): NormalizedSession => ({ ...session([turn(0, [])]), mode, systemPrompt: systemPrompt as string[] });

  it("shows a closed line above the first turn that opens to the prompt", () => {
    const { el } = renderTranscript(withPrompt("full", ["You are an agent.", "Be brief."]));
    const line = el.querySelector<HTMLElement>("#system-prompt")!;
    expect(el.firstElementChild?.classList.contains("session-context")).toBe(true);
    expect(line.textContent).toContain("system prompt");
    expect(line.textContent).toContain("2 sections");
    expect(line.textContent).not.toContain("You are an agent.");
    line.querySelector<HTMLButtonElement>("button.tline")!.click();
    expect(line.querySelector("pre")?.textContent).toBe("You are an agent.\n\nBe brief.");
  });

  it("is not drawn outside full mode or when malformed", () => {
    for (const s of [withPrompt("brief", ["x"]), withPrompt("full", "not a list"), withPrompt("full", [1, ""]), withPrompt("full", undefined)]) {
      expect(renderTranscript(s).el.querySelector("#system-prompt")).toBeNull();
    }
  });
});

describe("token rail skills", () => {
  const skill = (id: string, name: string, invokedBy?: "user" | "model"): Step => ({ kind: "event", id, event: "skill", text: `Skill loaded: ${name}`, ...(invokedBy ? { skill: { name, invokedBy } } : {}) });
  const skillTool = (id: string, name: string): Step => ({ kind: "tool", id, name: "Skill", action: "other", summary: name, input: { skill: name } });
  const typedAndModel = () => {
    const s = session([
      turn(0, [skill("a", "assess-review-feedback", "user"), { kind: "text", id: "b", text: "on it" }], "/assess-review-feedback"),
      turn(1, [skillTool("c", "agent-browser"), skill("d", "agent-browser", "model"), skillTool("e", "agent-browser"), skill("f", "agent-browser", "model")]),
    ]);
    s.stats.tools = { Skill: 2 };
    s.stats.toolCalls = 2;
    return s;
  };
  const rail = (s: NormalizedSession, onJumpTo?: (id: string) => void) => renderTokenRail(s, renderTranscript(s).turns, () => {}, onJumpTo).el;
  const section = (el: HTMLElement) => Array.from(el.querySelectorAll(".rail-sec")).find((x) => x.querySelector("h3")?.textContent?.startsWith("Skills"));
  const rows = (el: Element | undefined) => Array.from(el?.querySelectorAll(".bars-row") ?? [], (r) => [r.querySelector(".bars-name")?.textContent, r.querySelector(".bars-n")?.textContent]);

  afterEach(() => closeHoverCard());

  it("lists typed and model-loaded skills apart from the Skill tool calls", () => {
    const el = rail(typedAndModel());
    const sec = section(el);
    expect(sec?.querySelector("h3 .help")?.textContent).toBe("Skills · 3");
    expect(rows(sec)).toEqual([
      ["agent-browser", "2"],
      ["assess-review-feedback", "1"],
    ]);
    // A typed skill is no tool call: Tools still counts the two Skill calls only.
    const tools = Array.from(el.querySelectorAll(".rail-sec")).find((x) => x.querySelector("h3")?.textContent?.startsWith("Tools"));
    expect(rows(tools)).toEqual([["Skill", "2"]]);
  });

  it("shows each load and who loaded it on hover, and jumps to the one picked", () => {
    const jumps: string[] = [];
    const el = rail(typedAndModel(), (id) => jumps.push(id));
    const [browser, typed] = Array.from(section(el)!.querySelectorAll<HTMLElement>(".bars-row"));
    typed!.click();
    const items = () => Array.from(document.querySelectorAll(".hcard .hc-item"), (i) => [i.querySelector(".hc-turn")?.textContent, i.querySelector(".hc-text")?.textContent]);
    expect(document.querySelector(".hcard .hc-count")?.textContent).toBe("1 load");
    expect(items()).toEqual([["1", "typed as a command"]]);
    browser!.click();
    expect(items()).toEqual([
      ["2", "loaded by the model"],
      ["2", "loaded by the model"],
    ]);
    document.querySelector<HTMLButtonElement>(".hcard .hc-item")!.click();
    expect(jumps).toEqual(["s-1-1"]);
  });

  it("keeps every skill reachable: one past the first twelve is shown, more fold behind a toggle", () => {
    const many = (n: number) => session([turn(0, Array.from({ length: n }, (_, i) => skill(`k${i}`, `skill-${String(i).padStart(2, "0")}`, "model")))]);
    expect(rows(section(rail(many(13))))).toHaveLength(13);
    expect(section(rail(many(13)))!.querySelector("button.bars-toggle")).toBeNull();

    const sec = section(rail(many(14)))!;
    const toggle = () => sec.querySelector<HTMLButtonElement>("button.bars-toggle")!;
    expect(rows(sec)).toHaveLength(12);
    expect(toggle().textContent).toBe("+2 more skills");
    toggle().click();
    expect(rows(sec).map(([name]) => name)).toEqual(Array.from({ length: 14 }, (_, i) => `skill-${String(i).padStart(2, "0")}`));
    expect(toggle().textContent).toBe("show fewer");
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    // A skill past the fold opens its card like any other.
    sec.querySelectorAll<HTMLElement>(".bars-row")[13]!.click();
    expect(document.querySelector(".hcard .hc-title")?.textContent).toBe("skill-13");
    toggle().click();
    expect(rows(sec)).toHaveLength(12);
  });

  it("names skills from an older share's event text, and lists none where the view keeps no skill events", () => {
    const old = session([turn(0, [skill("a", "ticket")])]);
    expect(rows(section(rail(old)))).toEqual([["ticket", "1"]]);
    expect(section(rail(projectSession(typedAndModel(), "brief")))).toBeDefined();
    expect(section(rail(projectSession(typedAndModel(), "minimal")))).toBeUndefined();
  });
});
