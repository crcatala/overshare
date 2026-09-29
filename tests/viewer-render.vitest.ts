// @vitest-environment jsdom
/** What the transcript and token rail render for the session data they're given. */
import { describe, expect, it } from "vitest";
import { SCHEMA_VERSION, type NormalizedSession, type ShareMode, type Step, type Turn, type Usage } from "../src/schema.ts";

(globalThis as { __AGENT_SHARE_SOURCES__?: Record<string, string> }).__AGENT_SHARE_SOURCES__ = {};
const { renderTranscript } = await import("../viewer/src/transcript.ts");
const { renderTokenRail } = await import("../viewer/src/tokens.ts");
const { renderHeader } = await import("../viewer/src/header.ts");
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
    expect(chips).toEqual(["Bash×3", "Edit"]);
    expect(group!.querySelector(".chip.is-error")?.textContent).toBe("Bash×3");
    expect(group!.querySelector(".tprev pre")?.textContent).toBe("~ src/a.ts\n$ npm test");
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
  const controls = (view: ShareMode) => ({
    sharedMode: "full" as const,
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
});
