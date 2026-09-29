// @vitest-environment jsdom
/** What the transcript and token rail render for the session data they're given. */
import { describe, expect, it } from "vitest";
import { SCHEMA_VERSION, type NormalizedSession, type ShareMode, type Step, type Turn, type Usage } from "../src/schema.ts";

(globalThis as { __AGENT_SHARE_SOURCES__?: Record<string, string> }).__AGENT_SHARE_SOURCES__ = {};
const { renderTranscript } = await import("../viewer/src/transcript.ts");
const { renderTokenRail } = await import("../viewer/src/tokens.ts");
const { renderHeader } = await import("../viewer/src/header.ts");
const { closeHoverCard } = await import("../viewer/src/popover.ts");
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

const turn = (index: number, steps: Step[], text = `prompt ${index}`): Turn => ({ index, user: { text }, steps });

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
    setView: () => {},
    toggleTheme: () => {},
    toggleRail: () => {},
    settings: { current: () => VARIANTS[0]!, onPick: () => {} },
    local: false,
  });
  const buttons = (el: HTMLElement) =>
    Object.fromEntries(Array.from(el.querySelectorAll<HTMLButtonElement>(".modes button"), (b) => [b.textContent, b.disabled]));

  // Regression: the switch read the modes on offer from the projected session, so once a
  // full share was viewed as brief, "full" was disabled and there was no way back.
  it("keeps every mode the share allows on offer while viewing a smaller one", () => {
    const shared = session([turn(0, [])]);
    for (const view of ["brief", "minimal"] as const) {
      const el = renderHeader(projectSession(shared, view), undefined, controls(view));
      expect(buttons(el)).toEqual({ full: false, brief: false, minimal: false });
      expect(el.querySelector(".facts-share dd")?.textContent).toBe("full");
    }
  });

  it("keeps modes that weren't published unavailable", () => {
    const el = renderHeader(projectSession(session([turn(0, [])]), "brief"), undefined, controls("minimal", "brief"));
    expect(buttons(el)).toEqual({ full: true, brief: false, minimal: false });
    expect(el.querySelector<HTMLButtonElement>(".modes button")?.title).toBe("Shared as brief; full detail was not published");
  });
});
