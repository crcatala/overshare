// @vitest-environment jsdom
/** Subagent usage in the viewer: rail section, header fact, per-turn attribution, the step line, and every share mode. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseClaudeCode } from "../src/harnesses/claude-code/parse.ts";
import { COST_UNDERCOUNT_NOTE, describeCost } from "../src/format.ts";
import { projectSession } from "../src/modes.ts";
import { SCHEMA_VERSION, SHARE_MODES, type NormalizedSession, type ShareMode, type Step, type SubagentStep, type SubagentTotals, type Turn, type Usage } from "../src/schema.ts";
import { computeStats } from "../src/stats.ts";
import { loadSubagentFiles } from "../src/harnesses/claude-code/subagent-files.ts";
import { SUBAGENT_FIXTURES_DIR, fixtureSessionIds } from "./subagent-fixtures.ts";

(globalThis as { __AGENT_SHARE_SOURCES__?: Record<string, string> }).__AGENT_SHARE_SOURCES__ = {};
const { renderTranscript } = await import("../viewer/src/transcript.ts");
const { renderTokenRail } = await import("../viewer/src/tokens.ts");
const { renderHeader } = await import("../viewer/src/header.ts");
const { closeMenus } = await import("../viewer/src/menu.ts");
const { stepTokens, turnSubagents } = await import("../viewer/src/subagents.ts");

const usage = (context: number, output = 50): Usage => ({ input: 0, output, cacheRead: context, cacheWrite: 0, reasoning: 0 });
const totals = (over: Partial<SubagentTotals> = {}): SubagentTotals => ({ agents: 1, responses: 3, tokens: { input: 10, output: 200, cacheRead: 9_000, cacheWrite: 800, reasoning: 0 }, cost: 0.0421, byModel: {}, ...over });

function sub(id: string, u: SubagentStep["usage"], over: Partial<SubagentStep> = {}): SubagentStep {
  return { kind: "subagent", id, tool: "Agent", agents: ["reviewer"], description: `task ${id}`, ...(u ? { usage: u } : {}), ...over };
}

/** `turns[i]` are the steps of turn i; each turn has one main model call, so the turn foot and turn box exist. */
function build(turns: Step[][], stats: Partial<NormalizedSession["stats"]> = {}, harness: "claude-code" | "pi" = "claude-code"): NormalizedSession {
  const responses = turns.map((_, i) => ({ id: `r${i}`, turn: i, usage: usage(1_000) }));
  const count = turns.flatMap((t) => t).filter((s) => s.kind === "subagent").length;
  return {
    schema: SCHEMA_VERSION,
    mode: "full",
    harness: { name: harness },
    source: { sessionId: "test" },
    project: { cwd: "~/work/app", name: "app" },
    models: [],
    stats: {
      turns: turns.length,
      userPrompts: turns.length,
      responses: responses.length,
      toolCalls: count,
      tools: {},
      toolErrors: 0,
      thinking: { blocks: 0, chars: 0, tokens: 0 },
      subagents: count,
      compactions: 0,
      files: { read: 0, edited: 0, written: 0 },
      tokens: usage(turns.length * 1_000, turns.length * 50),
      peakContext: 1_000,
      cost: 1.5,
      costSource: "estimated",
      ...stats,
    },
    responses,
    turns: turns.map((steps, i) => ({ index: i, user: { text: `prompt ${i}`, authored: true }, steps: steps.map((s) => ({ ...s, responseId: `r${i}` })) as Step[] }) as Turn),
  };
}

const mount = (...nodes: Node[]) => {
  const tip = document.createElement("div");
  tip.id = "tooltip";
  tip.hidden = true;
  document.body.replaceChildren(tip, ...nodes);
};
const rail = (s: NormalizedSession) => {
  const { turns, el } = renderTranscript(s);
  const r = renderTokenRail(s, turns, () => {}, () => {});
  mount(r.el);
  return { ...r, turns, transcript: el };
};
const rows = (section: Element | null | undefined) => Object.fromEntries(Array.from(section?.querySelectorAll(".kv dt") ?? [], (dt) => [dt.textContent, dt.nextElementSibling?.textContent]));
const sections = (el: HTMLElement) => Object.fromEntries(Array.from(el.querySelectorAll(".rail-sec"), (sec) => [sec.querySelector("h3 .help")?.textContent ?? sec.querySelector("h3")?.firstChild?.textContent ?? "", sec]));
const headerFacts = (s: NormalizedSession) => {
  const el = renderHeader(s, undefined, { sharedMode: s.mode, view: s.mode, setView: () => {}, toggleTheme: () => {}, toggleRail: () => {}, settings: {} as never, share: {} as never, local: false });
  return Object.fromEntries(Array.from(el.querySelectorAll(".facts-stats > div"), (d) => [d.querySelector("dt")?.textContent, d.querySelector("dd")?.textContent]));
};

afterEach(() => {
  closeMenus();
  document.body.replaceChildren();
});

const SUB_USAGE = { input: 10, output: 200, cacheRead: 9_000, cacheWrite: 800, totalTokens: 10_010, turns: 3, toolUses: 4, durationMs: 62_000, cost: 0.0421, models: ["claude-haiku-4-5-20251001"] };

describe("a subagent's tokens", () => {
  it("prefers the reported total and otherwise counts every token class, cache writes included", () => {
    expect(stepTokens({ totalTokens: 500, input: 1 })).toBe(500);
    expect(stepTokens({ input: 10, output: 200, cacheRead: 9_000, cacheWrite: 800 })).toBe(10_010);
    expect(stepTokens({ toolUses: 3 })).toBeUndefined();
  });
});

describe("what a turn's subagents add up to", () => {
  const turnOf = (steps: Step[]): Turn => build([steps]).turns[0]!;

  it("sums parallel subagents, keeps the longest run and leaves out steps without tokens", () => {
    const t = turnSubagents(turnOf([sub("a", SUB_USAGE), sub("b", { ...SUB_USAGE, totalTokens: 5_000, durationMs: 9_000, cost: 0.01, toolUses: 1, turns: 2 }), sub("c", undefined), sub("d", { toolUses: 2 })]));
    expect(t).toEqual({ agents: 2, tokens: 15_010, calls: 5, toolUses: 5, durationMs: 62_000, cost: 0.0521 });
  });

  it("marks a total with an unpriced agent as a lower bound", () => {
    const { cost: _cost, ...unpriced } = SUB_USAGE;
    expect(turnSubagents(turnOf([sub("a", SUB_USAGE), sub("b", unpriced)]))).toMatchObject({ agents: 2, cost: 0.0421, costPartial: true });
    expect(turnSubagents(turnOf([sub("b", unpriced)]))?.cost).toBeUndefined();
  });

  it("is absent for a turn with no subagent usage", () => {
    expect(turnSubagents(turnOf([{ kind: "text", id: "t", text: "hi" } as Step]))).toBeUndefined();
  });
});

describe("subagent step", () => {
  const entry = (s: SubagentStep) => renderTranscript(build([[s]])).el.querySelector<HTMLElement>(".entry.k-sub")!;

  it("shows the total in the vocabulary of the rail and a breakdown when opened", () => {
    const e = entry(sub("a", SUB_USAGE, { async: true, result: { text: "found 3 issues" } }));
    expect(e.querySelector(".tmeta")?.textContent).toBe("10.0k tokens · 3 model calls · 4 tool calls · 1m 2s · $0.042");
    e.querySelector<HTMLButtonElement>("button.tline")!.click();
    expect(e.querySelector(".sub-usage")?.textContent).toBe("cache read 9.0k · cache write 800 · uncached input 10 · output 200 · claude-haiku-4-5-20251001");
    expect(e.querySelector(".tfull pre")?.textContent).toBe("found 3 issues");
  });

  it("says when a nested agent is folded in, and when the result was truncated", () => {
    const e = entry(sub("a", { ...SUB_USAGE, nested: 2 }, { result: { text: "x… [truncated 5 chars]", truncatedFrom: 4_005 } }));
    e.querySelector<HTMLButtonElement>("button.tline")!.click();
    expect(e.querySelector(".sub-usage")?.textContent).toContain("incl. 2 nested agents");
    expect(e.querySelector(".tfull .tnote")?.textContent).toBe("truncated from 4.0k chars when shared");
  });

  it("has nothing to open without a result or token detail (brief and minimal drop the result, keep the numbers)", () => {
    const e = entry(sub("a", { toolUses: 2 }));
    expect(e.querySelector("button.tline")).toBeNull();
  });
});

describe("turn attribution", () => {
  const s = build([[sub("a", SUB_USAGE), sub("b", { ...SUB_USAGE, totalTokens: 5_000, cost: 0.01 })], []], { subagentUsage: { ...totals({ agents: 2 }) } });

  it("adds a subagent line to the turn foot of the turn that launched them, and only that turn", () => {
    const { el, turns } = renderTranscript(s);
    const foots = Array.from(el.querySelectorAll(".turn-foot"));
    expect(foots[0]!.querySelector(".foot-sub")?.textContent).toBe("2 subagents · 15.0k tokens · 6 model calls · 8 tool calls · $0.052");
    expect(foots[0]!.textContent).toContain("1 model call"); // the main call is still its own figure
    expect(foots[1]!.querySelector(".foot-sub")).toBeNull();
    expect(turns[0]!.subagents?.agents).toBe(2);
    expect(turns[1]!.subagents).toBeUndefined();
  });

  it("shows them in the rail's turn box apart from the turn's own figures, with the longest run", () => {
    const r = rail(s);
    r.setActive(0);
    const box = document.querySelector(".rail-turn .turn-sub")!;
    expect(box.querySelector("h4")?.textContent).toContain("Subagents launched");
    expect(rows(box)).toEqual({ subagents: "2", "tokens processed": "15.0k", "model calls": "6", "tool calls": "8", "est. cost": "$0.052", "longest run": "1m 2s" });
    r.setActive(1);
    expect(document.querySelector(".rail-turn .turn-sub")).toBeNull();
  });

  it("does not plot them: the context chart has one column per main turn and its help says why", () => {
    const r = rail(s);
    expect(r.el.querySelectorAll(".chart")[0]!.querySelectorAll(".cols:not(.cols-out) > .col").length).toBe(2);
    expect(sections(r.el)["Context by turn"]!.querySelector(".sr-only")?.textContent).toContain("Subagents are not drawn");
  });
});

describe("pi subagents", () => {
  // pi reports child usage for some launches only, so summing it would undercount the launches.
  const pi = () => build([[sub("a", { totalTokens: 14_000, cost: 0.02, turns: 3 }), sub("b", undefined), sub("c", undefined)]], {}, "pi");

  it("are not summed per turn: no footer line, no turn-box block, no aggregate", () => {
    const s = pi();
    const { el, turns } = renderTranscript(s);
    expect(el.querySelector(".foot-sub")).toBeNull();
    expect(turns[0]!.subagents).toBeUndefined();
    const r = rail(s);
    r.setActive(0);
    expect(document.querySelector(".rail-turn .turn-sub")).toBeNull();
    expect(el.querySelector(".k-sub .tmeta")?.textContent).toBe("14.0k tokens · 3 model calls · $0.020"); // the chip stays
  });
});

describe("rail: subagents beside the main totals", () => {
  it("labels the session figures as the main conversation and lists subagents on their own, never mixed in", () => {
    const s = build([[sub("a", SUB_USAGE)]], { subagentUsage: totals({ agents: 2, responses: 7 }) });
    const { el } = rail(s);
    const secs = sections(el);
    expect(secs["Session"]!.querySelector("h3 .h3-meta")?.textContent).toBe("main conversation");
    expect(rows(secs["Session"])["model calls"]).toBe("1"); // main only
    expect(rows(secs["Session"])["tokens processed"]).toBe("1.1k");
    expect(rows(secs["Subagents"])).toEqual({ subagents: "2", "tokens processed": "10.0k", "est. cost": "$0.042", "model calls": "7" });
    expect(secs["Subagents"]!.querySelector("h3 .h3-meta")?.textContent).toBe("not in totals");
  });

  it("shows subagent spend that no step launched as its own row", () => {
    const s = build([[]], { subagentUsage: totals({ agents: 0, responses: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, cost: undefined, unlinked: totals({ agents: 1, responses: 4, cost: 0.2 }) }) });
    const { el } = rail(s);
    expect(rows(sections(el)["Subagents"])).toEqual({ "not launched here": "$0.200 · 1 agent" });
  });

  it("has no Subagents section, and no main-conversation label, without subagent usage (pi, or none launched)", () => {
    const { el } = rail(build([[sub("a", { totalTokens: 14_000 })]], {}, "pi"));
    const secs = sections(el);
    expect(secs["Subagents"]).toBeUndefined();
    expect(secs["Session"]!.querySelector("h3 .h3-meta")).toBeNull();
  });

  it("explains the figures on hover: cost basis and model split", () => {
    const s = build([[]], { subagentUsage: totals({ byModel: { "claude-haiku-4-5-20251001": { responses: 3, tokens: totals().tokens, cost: 0.0421 } } }) });
    const { el } = rail(s);
    const tip = document.getElementById("tooltip")!;
    const cost = sections(el)["Subagents"]!.querySelectorAll<HTMLElement>(".kv dd .has-tip")[1]!;
    cost.dispatchEvent(new Event("mouseover", { bubbles: true }));
    cost.dispatchEvent(new Event("focus"));
    expect(tip.textContent).toContain("Estimated cost of subagents");
    expect(tip.textContent).toContain("claude-haiku-4-5-20251001: 3 calls");
    expect(tip.textContent).toContain(COST_UNDERCOUNT_NOTE);
  });

  it("carries the surcharge caveat on the header fact and the unlinked row too", () => {
    const s = build([[]], { subagents: 0, subagentUsage: totals({ unlinked: totals({ agents: 1 }) }) });
    const hover = (e: HTMLElement) => {
      e.dispatchEvent(new Event("mouseover", { bubbles: true }));
      e.dispatchEvent(new Event("focus"));
      return document.getElementById("tooltip")!.textContent;
    };
    const header = renderHeader(s, undefined, { sharedMode: "full", view: "full", setView: () => {}, toggleTheme: () => {}, toggleRail: () => {}, settings: {} as never, share: {} as never, local: false });
    mount(header);
    const fact = Array.from(header.querySelectorAll<HTMLElement>(".facts-stats .has-tip")).find((e) => e.textContent?.startsWith("2 (~"))!;
    expect(hover(fact)).toContain(COST_UNDERCOUNT_NOTE);
    const { el } = rail(s);
    const unlinked = Array.from(sections(el)["Subagents"]!.querySelectorAll<HTMLElement>(".kv .has-tip")).at(-1)!;
    expect(hover(unlinked)).toContain(COST_UNDERCOUNT_NOTE);
  });
});

describe("header fact", () => {
  it("reads 'subagents: N (~$X)' from the subagent transcripts", () => {
    const facts = headerFacts(build([[sub("a", SUB_USAGE)]], { subagentUsage: totals({ agents: 3 }) }));
    expect(facts.subagents).toBe("3 (~$0.042)");
  });

  it("includes subagents no step launched, and marks an unpriced total as a lower bound", () => {
    const facts = headerFacts(build([[]], { subagents: 0, subagentUsage: totals({ agents: 1, costPartial: true, unlinked: totals({ agents: 2, cost: 0.1 }) }) }));
    expect(facts.subagents).toBe("3 (~$0.142+)");
  });

  it("is absent when no subagent ran", () => {
    expect(headerFacts(build([[]])).subagents).toBeUndefined();
  });

  it("stays the launch count where there is no usage to sum (pi)", () => {
    expect(headerFacts(build([[sub("a", { totalTokens: 100 })]], {}, "pi")).subagents).toBe("1");
  });
});

describe("cost scope wording", () => {
  const base = build([[]]).stats;
  it("no longer says subagent usage is missing when it is shown separately", () => {
    expect(describeCost({ ...base, subagents: 2, subagentUsage: totals() }).join(" ")).toContain("Subagent usage is not included; it is shown separately.");
  });
  it("keeps the caveat where subagents ran with no usage (pi), and drops it where none ran", () => {
    expect(describeCost({ ...base, subagents: 2 }).join(" ")).toContain("Subagent usage is not included.");
    expect(describeCost({ ...base, subagents: 0 }).join(" ")).not.toMatch(/Subagent/);
  });
});

describe("share modes", () => {
  const s = build([[sub("a", SUB_USAGE, { result: { text: "SECRET-RESULT-TEXT" } })], []], { subagentUsage: totals() });
  const view = (mode: ShareMode) => projectSession(s, mode);

  it("keeps the rail and header figures in every mode (stats are computed before projection)", () => {
    for (const mode of SHARE_MODES) {
      const v = view(mode);
      expect(v.stats.subagentUsage, mode).toEqual(s.stats.subagentUsage);
      expect(rows(sections(rail(v).el)["Subagents"]), mode).toMatchObject({ subagents: "1", "est. cost": "$0.042" });
      expect(headerFacts(v).subagents, mode).toBe("1 (~$0.042)");
    }
  });

  it("brief and minimal keep the step's numbers and drop the result; full keeps it; prompts has no per-agent rows", () => {
    for (const mode of ["brief", "minimal"] as const) {
      const { el } = renderTranscript(view(mode));
      expect(el.querySelector(".k-sub .tmeta")?.textContent, mode).toContain("10.0k tokens");
      expect(el.textContent, mode).not.toContain("SECRET-RESULT-TEXT");
      expect(el.querySelector(".turn-foot .foot-sub")?.textContent, mode).toContain("1 subagent · 10.0k tokens");
    }
    expect(renderTranscript(view("full")).el.textContent).toContain("SECRET-RESULT-TEXT");
    const prompts = renderTranscript(view("prompts"));
    expect(prompts.el.querySelector(".k-sub")).toBeNull();
    expect(prompts.el.querySelector(".foot-sub")).toBeNull();
    expect(prompts.el.textContent).not.toContain("SECRET-RESULT-TEXT");
    expect(prompts.turns.every((t) => t.subagents === undefined)).toBe(true);
  });
});

describe("an older share without the new fields", () => {
  it("renders as it did: a step with only counts, no stats.subagentUsage", () => {
    const s = build([[sub("a", { toolUses: 2, durationMs: 4_000 })]]);
    const { el, turns } = renderTranscript(s);
    expect(el.querySelector(".k-sub .tmeta")?.textContent).toBe("2 tool calls · 4s");
    expect(turns[0]!.subagents).toBeUndefined();
    expect(() => rail(s)).not.toThrow();
  });
});

describe("Claude fixture sessions through the viewer", () => {
  const dir = SUBAGENT_FIXTURES_DIR;
  const load = (prefix: string): NormalizedSession => {
    const path = join(dir, `${fixtureSessionIds().find((i) => i.startsWith(prefix))!}.jsonl`);
    const { session } = parseClaudeCode(readFileSync(path, "utf8"), { subagentFiles: loadSubagentFiles(path) });
    session.stats = computeStats(session);
    return session;
  };
  const steps = (s: NormalizedSession) => s.turns.flatMap((t) => t.steps).filter((x): x is SubagentStep => x.kind === "subagent");

  // async (two background agents), foreground, three in parallel, a custom agent on another model
  for (const [name, prefix, agents] of [["async background", "2b450029", 2], ["foreground", "491c3f9b", 1], ["parallel", "bf3c7500", 3], ["mixed model", "9a69feab", 1]] as const) {
    it(`${name}: the launching turns' subagent lines add up to the rail's subagent figures`, () => {
      const s = load(prefix);
      const sub = s.stats.subagentUsage!;
      expect(sub.agents).toBe(agents);
      const { turns } = rail(s);
      const fromTurns = turns.reduce((n, t) => n + (t.subagents?.tokens ?? 0), 0);
      const fromSteps = steps(s).reduce((n, st) => n + stepTokens(st.usage!)!, 0);
      const fromStats = sub.tokens.input + sub.tokens.output + sub.tokens.cacheRead + sub.tokens.cacheWrite;
      expect(fromTurns).toBe(fromSteps);
      expect(fromTurns).toBe(fromStats);
      expect(rows(sections(document.querySelector<HTMLElement>(".tokens")!)["Subagents"])).toMatchObject({ subagents: String(agents) });
      expect(headerFacts(s).subagents).toMatch(new RegExp(`^${agents} \\(~\\$`));
    });
  }

  it("a forked skill has no launching step: its spend is the 'not launched here' row and still in the header", () => {
    const s = load("1ccce9c5");
    expect(steps(s)).toHaveLength(0);
    const { el } = rail(s);
    expect(rows(sections(el)["Subagents"])["not launched here"]).toMatch(/1 agent$/);
    expect(headerFacts(s).subagents).toMatch(/^1 \(~\$/);
  });
});
