// @vitest-environment jsdom
/** Cache misses in the viewer: chart markers, the Cache rail section, the turn box, the header and the turn foot. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cacheEventDetail, cacheEventLabel, formatCacheMisses, formatCacheSummary } from "../src/format.ts";
import { SCHEMA_VERSION, type CacheEvent, type CacheSummary, type NormalizedSession, type ResponseUsage, type Step, type Turn, type Usage } from "../src/schema.ts";

(globalThis as { __OVERSHARE_SOURCES__?: Record<string, string> }).__OVERSHARE_SOURCES__ = {};
const { renderTranscript } = await import("../viewer/src/transcript.ts");
const { renderTokenRail } = await import("../viewer/src/tokens.ts");
const { renderHeader } = await import("../viewer/src/header.ts");
const { closeMenus } = await import("../viewer/src/menu.ts");
const { VARIANTS } = await import("../viewer/src/variants.ts");

const usage = (context: number, output = 50, cacheWrite = 0): Usage => ({ input: 0, output, cacheRead: context, cacheWrite, reasoning: 0 });
const idleMiss: CacheEvent = { kind: "miss", recached: 385_286, gapMs: 271 * 60_000, idle: true, cost: 3.0052 };
const summary = (extra: Partial<CacheSummary> = {}): CacheSummary => ({ requests: 10, cachedPct: 99, misses: 1, rebuilds: 0, modelSwitches: 0, recached: 385_286, extraCost: 3.0052, ...extra });

interface Call {
  turn: number;
  event?: CacheEvent;
  context?: number;
}

/** One prompt and one text step per turn; `calls` are the model calls, each in a turn. */
function build(calls: Call[], stats: Partial<NormalizedSession["stats"]> = {}, turnCount = Math.max(...calls.map((c) => c.turn)) + 1): NormalizedSession {
  const turns: Turn[] = Array.from({ length: turnCount }, (_, i) => ({ index: i, user: { text: `prompt ${i}`, authored: true }, steps: [] }));
  const responses: ResponseUsage[] = calls.map((c, i) => {
    const id = `r${i}`;
    turns[c.turn]!.steps.push({ kind: "text", id: `t${i}`, responseId: id, text: `reply ${i}` } as Step);
    return { id, turn: c.turn, usage: usage(c.context ?? 1_000), ...(c.event ? { cacheEvent: c.event } : {}) };
  });
  return {
    schema: SCHEMA_VERSION,
    mode: "full",
    harness: { name: "claude-code" },
    source: { sessionId: "test" },
    project: { cwd: "~/work/app", name: "app" },
    models: [],
    stats: {
      turns: turnCount,
      userPrompts: turnCount,
      responses: responses.length,
      toolCalls: 0,
      tools: {},
      toolErrors: 0,
      thinking: { blocks: 0, chars: 0, tokens: 0 },
      subagents: 0,
      compactions: 0,
      files: { read: 0, edited: 0, written: 0 },
      tokens: responses.reduce((t, r) => ({ ...t, cacheRead: t.cacheRead + r.usage.cacheRead, output: t.output + r.usage.output }), usage(0, 0)),
      peakContext: Math.max(0, ...responses.map((r) => r.usage.cacheRead)),
      ...stats,
    },
    responses,
    turns,
  };
}

/** The page's tooltip element, which the hover text is written into. */
const mount = (...nodes: Node[]) => {
  const tip = document.createElement("div");
  tip.id = "tooltip";
  tip.hidden = true;
  document.body.replaceChildren(tip, ...nodes);
};
const rail = (s: NormalizedSession, onJumpTo: (id: string) => void = () => {}) => {
  const { turns, el } = renderTranscript(s);
  const r = renderTokenRail(s, turns, () => {}, onJumpTo);
  mount(r.el);
  return { ...r, turns, transcript: el };
};
const sectionTitles = (el: HTMLElement) => Array.from(el.querySelectorAll(".rail-sec > h3"), (h) => (h.querySelector(".help") ?? h).textContent);
const railRows = (el: HTMLElement) => Object.fromEntries(Array.from(el.querySelectorAll(".rail-sec:first-child .kv dt"), (dt) => [dt.textContent, dt.nextElementSibling?.textContent]));

afterEach(() => {
  closeMenus();
  document.body.replaceChildren();
});

describe("cache wording", () => {
  it("names each event in Claude Code's vocabulary, with the idle gap only when it explains a miss", () => {
    expect(cacheEventLabel(idleMiss)).toBe("cache miss after 4h 31m idle");
    expect(cacheEventLabel({ kind: "miss", recached: 5000, gapMs: 5000 })).toBe("cache miss");
    expect(cacheEventLabel({ kind: "rebuild", recached: 5000 })).toBe("expected rebuild after compaction");
    expect(cacheEventLabel({ kind: "model-switch", recached: 5000 })).toBe("expected re-cache after model switch");
    expect(cacheEventDetail(idleMiss)).toBe("385k re-cached, ~$3.01");
    expect(cacheEventDetail({ kind: "miss", recached: 5000 })).toBe("5.0k re-cached");
  });

  it("summarizes like /usage, leaving out what is zero and marking a lower bound", () => {
    expect(formatCacheSummary(summary({ rebuilds: 1, misses: 2 }))).toBe("2 misses · 1 expected rebuild · ~$3.01 extra");
    expect(formatCacheSummary(summary({ misses: 0, rebuilds: 0, modelSwitches: 2, extraCost: undefined }))).toBe("2 model switches");
    expect(formatCacheSummary(summary({ extraCostPartial: true }))).toBe("1 miss · ~$3.01+ extra");
    expect(formatCacheMisses(summary())).toBe("1 (~$3.01)");
    expect(formatCacheMisses(summary({ extraCost: undefined }))).toBe("1");
  });
});

describe("context by turn chart markers", () => {
  const withMiss = () => build([{ turn: 0 }, { turn: 1, event: idleMiss }, { turn: 2 }], { cache: summary() });

  it("marks the column of a turn with a miss, with a shape and a legend entry", () => {
    const { el } = rail(withMiss());
    const marks = Array.from(el.querySelectorAll(".marks .colmark"));
    expect(marks.map((m) => m.querySelector(".mark") !== null)).toEqual([false, true, false]);
    const mark = marks[1]!.querySelector(".mark")!;
    expect(mark.classList.contains("mark-miss")).toBe(true);
    // A shape, so it does not depend on colour: a filled triangle for a miss, an outline diamond for expected events.
    expect(mark.querySelector("path")!.getAttribute("fill")).toBe("currentColor");
    expect(el.querySelector(".legend")!.textContent).toContain("cache miss");
    expect(el.querySelector(".legend .mark-miss")).not.toBeNull();
    expect(el.querySelector(".legend")!.textContent).not.toContain("expected rebuild");
  });

  it("draws expected events with a different shape and their own legend entry", () => {
    const s = build([{ turn: 0 }, { turn: 1, event: { kind: "rebuild", recached: 8_000 } }, { turn: 2, event: { kind: "model-switch", recached: 8_000 } }], { cache: summary({ misses: 0, rebuilds: 1, modelSwitches: 1, extraCost: undefined }) });
    const { el } = rail(s);
    const marks = Array.from(el.querySelectorAll(".marks .colmark .mark"));
    expect(marks).toHaveLength(2);
    expect(marks.every((m) => m.classList.contains("mark-expected"))).toBe(true);
    expect(marks[0]!.querySelector("path")!.getAttribute("fill")).toBe("none");
    expect(el.querySelector(".legend")!.textContent).toContain("expected rebuild");
    expect(el.querySelector(".legend")!.textContent).not.toContain("cache miss");
  });

  it("names the event in the column's tooltip and jumps to its turn on click", () => {
    const jumps: number[] = [];
    const s = withMiss();
    const { turns } = renderTranscript(s);
    const r = renderTokenRail(s, turns, (t) => jumps.push(t));
    mount(r.el);
    const cell = r.el.querySelectorAll<HTMLElement>(".marks .colmark")[1]!;
    cell.dispatchEvent(new Event("pointerenter"));
    expect(document.querySelector(".tooltip")!.textContent).toContain("cache miss after 4h 31m idle: 385k re-cached, ~$3.01");
    cell.click();
    expect(jumps).toEqual([1]);
  });

  it("keeps the marker when columns are bucketed and counts the events they hide", () => {
    // 200 turns collapse into at most 90 columns; the one event must not be averaged away.
    const calls: Call[] = Array.from({ length: 200 }, (_, i) => ({ turn: i, ...(i === 137 ? { event: idleMiss } : {}) }));
    const { el } = rail(build(calls, { cache: summary() }));
    const cols = el.querySelectorAll(".rail-sec .cols:not(.cols-out) .col");
    expect(cols.length).toBeLessThanOrEqual(90);
    const marked = Array.from(el.querySelectorAll(".marks .colmark")).flatMap((m, i) => (m.querySelector(".mark") ? [i] : []));
    expect(marked).toHaveLength(1);
    el.querySelectorAll<HTMLElement>(".marks .colmark")[marked[0]!]!.dispatchEvent(new Event("pointerenter"));
    expect(document.querySelector(".tooltip")!.textContent).toContain("1 cache event in these turns");
  });

  it("marks the most serious kind when a bucket holds several", () => {
    const calls: Call[] = Array.from({ length: 200 }, (_, i) => ({ turn: i, ...(i === 10 ? { event: { kind: "rebuild" as const, recached: 5_000 } } : i === 11 ? { event: idleMiss } : {}) }));
    const { el } = rail(build(calls, { cache: summary({ rebuilds: 1 }) }));
    const marks = Array.from(el.querySelectorAll(".marks .mark"));
    expect(marks).toHaveLength(1);
    expect(marks[0]!.classList.contains("mark-miss")).toBe(true);
  });

  it("adds nothing to a session without events", () => {
    const { el } = rail(build([{ turn: 0 }, { turn: 1 }], { cache: summary({ misses: 0, extraCost: undefined }) }));
    expect(el.querySelector(".marks")).toBeNull();
    expect(el.querySelector(".legend .mark")).toBeNull();
    expect(sectionTitles(el)).not.toContain("Cache");
  });
});

describe("Cache section", () => {
  const events = () =>
    build(
      [
        { turn: 0 },
        { turn: 1, event: { kind: "rebuild", recached: 21_000, gapMs: 84_000, cost: 0.04 } },
        { turn: 2, event: idleMiss },
        { turn: 3, event: { kind: "model-switch", recached: 11_000, gapMs: 126_000 } },
      ],
      { cache: summary({ rebuilds: 1, modelSwitches: 1 }) },
    );

  it("sits between Session and Context by turn, with the summary line and one row per event, largest first", () => {
    const { el } = rail(events());
    expect(sectionTitles(el).slice(0, 3)).toEqual(["Session", "Cache", "Context by turn"]);
    expect(el.querySelector(".cache-sum")!.textContent).toBe("1 miss · 1 expected rebuild · 1 model switch · ~$3.01 extra");
    const rows = Array.from(el.querySelectorAll("button.cache-row"), (r) => Array.from(r.querySelectorAll("span"), (s) => s.textContent));
    // Prompt number (turns count from 1), kind, gap, re-cached, extra.
    expect(rows).toEqual([
      ["3", "miss", "4h 31m", "385k", "$3.01"],
      ["2", "rebuild", "1m 24s", "21.0k", "$0.040"],
      ["4", "switch", "2m 6s", "11.0k", "–"],
    ]);
  });

  it("jumps to the step of the model call when a row is picked", () => {
    const jumped: string[] = [];
    const { el, transcript } = rail(events(), (id) => jumped.push(id));
    el.querySelector<HTMLElement>("button.cache-row")!.click();
    expect(jumped).toHaveLength(1);
    // The miss is r2, whose one step is the first of turn 2.
    expect(jumped[0]).toBe("s-2-0");
    expect(transcript.querySelector(`#${jumped[0]}`)).not.toBeNull();
  });

  it("falls back to the turn when the view does not show the step", () => {
    const s = events();
    s.mode = "prompts";
    const jumped: string[] = [];
    const { el, transcript } = rail(s, (id) => jumped.push(id));
    el.querySelector<HTMLElement>("button.cache-row")!.click();
    expect(jumped).toEqual(["turn-2"]);
    expect(transcript.querySelector("#turn-2")).not.toBeNull();
  });

  it("caps the rows and offers the rest", () => {
    const calls: Call[] = [{ turn: 0 }, ...Array.from({ length: 9 }, (_, i) => ({ turn: i + 1, event: { kind: "miss" as const, recached: 10_000 + i } }))];
    const { el } = rail(build(calls, { cache: summary({ misses: 9 }) }));
    expect(el.querySelectorAll("button.cache-row")).toHaveLength(6);
    const more = el.querySelector<HTMLButtonElement>(".cache-list .bars-toggle")!;
    expect(more.textContent).toBe("+3 more");
    more.click();
    expect(el.querySelectorAll("button.cache-row")).toHaveLength(9);
    expect(el.querySelector(".cache-list .bars-toggle")!.textContent).toBe("show fewer");
  });

  it("explains what a miss is on hover", () => {
    const { el } = rail(events());
    const help = Array.from(el.querySelectorAll(".rail-sec > h3")).find((h) => h.textContent?.startsWith("Cache"))!;
    const text = help.querySelector(".sr-only")!.textContent!;
    expect(text).toContain("5% and at least 2,000 tokens");
    expect(text).toContain("5 minutes to 1 hour");
    expect(text).toContain("Compaction and switching models are expected");
  });
});

describe("the turn in view", () => {
  it("says what happened, how much was re-cached and what it cost", () => {
    const { el, setActive } = rail(build([{ turn: 0 }, { turn: 1, event: idleMiss }], { cache: summary() }));
    setActive(1);
    const line = el.querySelector(".rail-turn .turn-cache")!;
    expect(line.textContent).toBe("cache miss after 4h 31m idle: 385k re-cached, ~$3.01");
    expect(line.querySelector(".mark-miss")).not.toBeNull();
    setActive(0);
    expect(el.querySelector(".rail-turn .turn-cache")).toBeNull();
  });

  it("marks the call's bar in the turn's own chart and names the event in its tooltip", () => {
    const { el, setActive } = rail(build([{ turn: 0, context: 5_000 }, { turn: 0, event: idleMiss }, { turn: 0, context: 5_000 }], { cache: summary() }));
    setActive(0);
    const marks = Array.from(el.querySelectorAll(".rail-turn .marks .colmark"), (m) => m.querySelector(".mark") !== null);
    expect(marks).toEqual([false, true, false]);
    el.querySelectorAll<HTMLElement>(".rail-turn .marks .colmark")[1]!.dispatchEvent(new Event("pointerenter"));
    expect(document.querySelector(".tooltip")!.textContent).toContain("cache miss after 4h 31m idle: 385k re-cached, ~$3.01");
  });
});

describe("turn foot", () => {
  it("says 'cache miss' for a turn that had one, in words as well as colour", () => {
    const { transcript } = rail(build([{ turn: 0 }, { turn: 1, event: idleMiss }], { cache: summary() }));
    const foots = Array.from(transcript.querySelectorAll(".turn-foot"), (f) => f.textContent);
    expect(foots[0]).not.toContain("cache miss");
    expect(foots[1]).toContain("cache miss");
    expect(transcript.querySelectorAll(".turn-foot .foot-cache")).toHaveLength(1);
  });
});

describe("header", () => {
  const controls = {
    sharedMode: "full" as const,
    view: "full" as const,
    setView: vi.fn(),
    toggleTheme: () => {},
    toggleRail: () => {},
    settings: { current: () => VARIANTS[0]!, onPick: () => {}, defaults: () => ({ canSave: false, canReset: false }), saveDefault: () => {}, resetDefault: () => {} },
    share: { source: { kind: "local" as const, name: "s.json" }, view: () => ({ ui: "", label: "" }), turn: () => undefined },
    local: false,
  };
  const facts = (s: NormalizedSession) => Object.fromEntries(Array.from(renderHeader(s, undefined, controls).querySelectorAll(".facts-stats > div"), (d) => [d.querySelector("dt")!.textContent, d.querySelector("dd")!.textContent]));

  it("shows 'cache misses' only when there are some, with what they cost", () => {
    expect(facts(build([{ turn: 0 }, { turn: 1, event: idleMiss }], { cache: summary() }))["cache misses"]).toBe("1 (~$3.01)");
    expect(facts(build([{ turn: 0 }], { cache: summary({ misses: 0, rebuilds: 1, extraCost: undefined }) }))).not.toHaveProperty("cache misses");
    expect(facts(build([{ turn: 0 }]))).not.toHaveProperty("cache misses");
  });

  it("calls the token figure 'tokens processed' and says what it counts", () => {
    const s = build([{ turn: 0 }]);
    const f = facts(s);
    expect(f["tokens processed"]).toBe("1.1k");
    expect(f["peak context"]).toBe("1.0k");
    expect(f).not.toHaveProperty("tokens");
    expect(f).not.toHaveProperty("peak ctx");
    const header = renderHeader(s, undefined, controls);
    mount(header);
    header.querySelector<HTMLElement>(".facts-stats .has-tip")!.dispatchEvent(new Event("pointerenter"));
    expect(document.querySelector(".tooltip")!.textContent).toContain("re-read from cache is counted again each time");
    expect(document.querySelector(".tooltip")!.textContent).toContain("uncached input");
  });
});

describe("session rows", () => {
  it("labels the hit rate as tokens and shows the miss count beside it", () => {
    const rows = railRows(rail(build([{ turn: 0 }, { turn: 1, event: idleMiss }], { cache: summary() })).el);
    expect(rows["cache hit (tokens)"]).toBe("99% · 1 miss");
    expect(rows).not.toHaveProperty("cached");
    expect(rows["model calls"]).toBe("2");
    expect(rows).not.toHaveProperty("responses");
    expect(rows["peak context"]).toBe("1.0k");
    expect(rows["tokens processed"]).toBe("2.1k");
  });

  it("shows the hit rate alone when nothing missed", () => {
    const rows = railRows(rail(build([{ turn: 0 }, { turn: 1 }], { cache: summary({ misses: 0, extraCost: undefined }) })).el);
    expect(rows["cache hit (tokens)"]).toBe("99%");
  });

  it("shows no cache UI at all for a provider that reports no cache tokens", () => {
    const s = build([{ turn: 0 }, { turn: 1 }]);
    for (const r of s.responses) r.usage = { input: 1_000, output: 50, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
    s.stats.tokens = { input: 2_000, output: 100, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
    const { el, transcript, setActive } = rail(s);
    expect(railRows(el)).not.toHaveProperty("cache hit (tokens)");
    setActive(0);
    expect(el.querySelector(".rail-turn")!.textContent).not.toContain("cache hit");
    expect(el.querySelector(".marks")).toBeNull();
    expect(transcript.querySelector(".turn-foot")!.textContent).not.toContain("cache");
    expect(sectionTitles(el)).not.toContain("Cache");
  });

  it("still renders a share made before cache events existed, with the hit rate from its tokens", () => {
    const s = build([{ turn: 0 }, { turn: 1 }]);
    expect(s.stats.cache).toBeUndefined();
    const { el } = rail(s);
    expect(railRows(el)["cache hit (tokens)"]).toBe("100%");
    expect(sectionTitles(el)).not.toContain("Cache");
    expect(renderHeader(s, undefined, { ...({} as never), sharedMode: "full", view: "full", setView: () => {}, toggleTheme: () => {}, toggleRail: () => {}, settings: { current: () => VARIANTS[0]!, onPick: () => {}, defaults: () => ({ canSave: false, canReset: false }), saveDefault: () => {}, resetDefault: () => {} }, share: { source: { kind: "local" as const, name: "s.json" }, view: () => ({ ui: "", label: "" }), turn: () => undefined }, local: false }).querySelector(".facts-stats")).not.toBeNull();
  });
});

describe("terminology", () => {
  it("says 'model call' and 'thinking' wherever the rail, header and turn foot show usage", () => {
    const s = build([{ turn: 0 }, { turn: 0, event: idleMiss }, { turn: 1 }], { cache: summary(), thinking: { blocks: 1, chars: 10, tokens: 200 } });
    s.stats.tokens.reasoning = 200;
    s.responses[0]!.usage.reasoning = 200;
    const { el, transcript, setActive } = rail(s);
    setActive(0);
    const header = renderHeader(s, undefined, { sharedMode: "full", view: "full", setView: () => {}, toggleTheme: () => {}, toggleRail: () => {}, settings: { current: () => VARIANTS[0]!, onPick: () => {}, defaults: () => ({ canSave: false, canReset: false }), saveDefault: () => {}, resetDefault: () => {} }, share: { source: { kind: "local" as const, name: "s.json" }, view: () => ({ ui: "", label: "" }), turn: () => undefined }, local: false });
    const visible = [el.textContent, header.textContent, ...Array.from(transcript.querySelectorAll(".turn-foot"), (f) => f.textContent), ...Array.from(el.querySelectorAll(".sr-only"), (n) => n.textContent)].join("\n");
    expect(visible).not.toMatch(/respons/i);
    expect(visible).not.toMatch(/\bthink\b/);
    expect(visible).not.toMatch(/\bctx\b/);
    expect(visible).not.toMatch(/new input/);
    expect(visible).toContain("model calls");
    expect(visible).toContain("(200 thinking)");
    expect(visible).toContain("uncached input");
    expect(el.querySelector(".legend")!.textContent).toContain("uncached input");
    expect(el.querySelector(".rail-turn")!.textContent).toContain("2 model calls");
  });
});

describe("a share is untrusted input", () => {
  it("ignores a cache event with an unknown kind or a non-numeric size, and drops bad gaps and costs", () => {
    const bad = { kind: "miss evil", recached: 5_000 } as unknown as CacheEvent;
    const noSize = { kind: "miss", recached: "lots" } as unknown as CacheEvent;
    const junk = { kind: "miss", recached: 5_000, gapMs: "soon", cost: Number.NaN, idle: "yes" } as unknown as CacheEvent;
    const s = build([{ turn: 0 }, { turn: 1, event: bad }, { turn: 2, event: noSize }, { turn: 3, event: junk }], { cache: summary({ misses: 3 }) });
    const { el, transcript, setActive } = rail(s);
    // Only the third is a usable event: a miss of 5.0k, with no gap, cost or idle claim.
    const rows = Array.from(el.querySelectorAll("button.cache-row"), (r) => Array.from(r.querySelectorAll("span"), (x) => x.textContent));
    expect(rows).toEqual([["4", "miss", "–", "5.0k", "–"]]);
    expect(el.querySelectorAll(".marks .mark")).toHaveLength(1);
    setActive(3);
    expect(el.querySelector(".rail-turn .turn-cache")!.textContent).toBe("cache miss: 5.0k re-cached");
    expect(document.body.innerHTML).not.toMatch(/NaN|evil|undefined/);
    const foots = Array.from(transcript.querySelectorAll(".turn-foot"), (f) => f.querySelectorAll(".foot-cache").length);
    expect(foots).toEqual([0, 0, 0, 1]);
    expect(el.querySelector('[class*="evil"]')).toBeNull();
  });
});
