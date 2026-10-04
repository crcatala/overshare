// @vitest-environment jsdom
/**
 * How the viewer treats shares that aren't exactly the format it was built for, and the frozen
 * shares (tests/fixtures/shares/) that keep every format it claims to open openable.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { SCHEMA_VERSION, type NormalizedSession } from "../src/schema.ts";

(globalThis as { __AGENT_SHARE_SOURCES__?: Record<string, string> }).__AGENT_SHARE_SOURCES__ = {};
const { MIGRATIONS, readShare, schemaVersion } = await import("../viewer/src/compat.ts");
const { renderTranscript } = await import("../viewer/src/transcript.ts");
const { renderCompatNotice } = await import("../viewer/src/notice.ts");
const { renderTokenRail } = await import("../viewer/src/tokens.ts");
const { renderHeader } = await import("../viewer/src/header.ts");
const { renderToc } = await import("../viewer/src/toc.ts");
const { buildIndex } = await import("../viewer/src/search.ts");
const { availableModes, projectSession, promptsUnavailableReason } = await import("../src/modes.ts");
const { VARIANTS } = await import("../viewer/src/variants.ts");

const SHARES = join(import.meta.dirname, "fixtures", "shares");
const versions = readdirSync(SHARES)
  .map((d) => /^agentshare-(\d+)$/.exec(d))
  .filter((m): m is RegExpExecArray => m !== null)
  .map((m) => Number(m[1]))
  .sort((a, b) => a - b);
const frozen = (version: number) =>
  readdirSync(join(SHARES, `agentshare-${version}`))
    .filter((f) => f.endsWith(".json"))
    .map((f) => ({ name: f, json: readFileSync(join(SHARES, `agentshare-${version}`, f), "utf8") }));
const current = schemaVersion(SCHEMA_VERSION)!;

const parsed = (json: string) => JSON.parse(json) as Record<string, unknown>;
const sample = () => parsed(frozen(current)[0]!.json);

describe("reading a share by its format version", () => {
  it("reads the current version as is, without a notice", async () => {
    const read = await readShare(sample());
    expect(read.newer).toBeUndefined();
    expect(read.session.schema).toBe(SCHEMA_VERSION);
  });

  it("reads a newer version best effort and says so", async () => {
    const read = await readShare({ ...sample(), schema: `agentshare/${current + 1}` });
    expect(read.session.turns.length).toBeGreaterThan(0);
    expect(read.newer).toEqual({ shared: `agentshare/${current + 1}`, viewer: SCHEMA_VERSION });
  });

  it("refuses an older version no migration reaches the current one from", async () => {
    await expect(readShare({ ...sample(), schema: `agentshare/${current - 1}` }, {})).rejects.toThrow("older format");
  });

  it("upgrades an older version through each migration in turn, loading only those it needs", async () => {
    const seen: string[] = [];
    const load = vi.fn();
    const migrations = {
      [current - 2]: async () => ({ default: (s: Record<string, unknown>) => (seen.push(`from ${s.schema}`), { ...s, title: "was renamed" }) }),
      [current - 1]: async () => ({ default: (s: Record<string, unknown>) => (seen.push(`from ${s.schema}`), { ...s, mode: s.mode }) }),
      [current + 5]: async () => (load(), { default: (s: Record<string, unknown>) => s }),
    };
    const read = await readShare({ ...sample(), schema: `agentshare/${current - 2}` }, migrations);
    expect(seen).toEqual([`from agentshare/${current - 2}`, `from agentshare/${current - 1}`]);
    expect(read.session.schema).toBe(SCHEMA_VERSION);
    expect(read.session.title).toBe("was renamed");
    expect(read.newer).toBeUndefined();
    expect(load).not.toHaveBeenCalled();
  });

  it.each([
    ["not an object", 42],
    ["null", null],
    ["no schema", { turns: [] }],
    ["another kind of schema", { schema: "somebody-else/1", turns: [] }],
    ["a non-numeric version", { schema: "agentshare/next", turns: [] }],
  ])("refuses %s", async (_name, data) => {
    await expect(readShare(data)).rejects.toThrow("isn't an agent-share session");
  });

  it("refuses a share with no turns", async () => {
    await expect(readShare({ schema: SCHEMA_VERSION })).rejects.toThrow("no turns");
  });

  it("parses versions strictly", () => {
    expect(schemaVersion("agentshare/2")).toBe(2);
    expect(schemaVersion("agentshare/12")).toBe(12);
    for (const bad of ["agentshare/", "agentshare/2.1", "agentshare/-1", "xagentshare/2", "agentshare/2 ", 2, undefined]) expect(schemaVersion(bad)).toBeUndefined();
  });
});

describe("a step the viewer can't draw", () => {
  const withSteps = (steps: unknown[]): NormalizedSession => {
    const s = sample() as unknown as NormalizedSession;
    return { ...s, mode: "full", turns: [{ index: 0, user: { text: "hello" }, steps: steps as never[] }] };
  };
  const text = { kind: "text", id: "a", text: "before" };
  const after = { kind: "text", id: "z", text: "after" };

  it("shows a placeholder for a kind from a newer format and keeps the steps around it", () => {
    const { el } = renderTranscript(withSteps([text, { kind: "diagram", id: "d", timestamp: "2026-03-10T14:00:00Z", svg: "<svg/>" }, after]));
    const entries = Array.from(el.querySelectorAll(".entry"));
    expect(entries.map((e) => e.className.replace("entry ", ""))).toEqual(["k-user", "k-text", "k-unsupported", "k-text"]);
    const placeholder = el.querySelector<HTMLElement>(".k-unsupported")!;
    expect(placeholder.dataset.kind).toBe("diagram");
    expect(placeholder.textContent).toContain("not supported by this viewer");
    expect(placeholder.id).toBe("s-0-1");
    expect(placeholder.querySelector("svg")).not.toBeNull();
  });

  it("shows a placeholder for a step whose data is not what its kind says, and keeps the rest of the turn", () => {
    const { el } = renderTranscript(withSteps([text, { kind: "tool", id: "t", name: "Bash", action: "exec", summary: "ls", input: { command: "ls" }, result: { text: 5 } }, after]));
    expect(el.querySelectorAll(".k-unsupported")).toHaveLength(1);
    expect(el.querySelector(".k-unsupported")?.textContent).toContain("couldn't be shown");
    expect(el.textContent).toContain("before");
    expect(el.textContent).toContain("after");
  });

  it("shows a placeholder for a turn it can't read at all, and keeps the turns around it", () => {
    const s = withSteps([text]);
    s.turns = [s.turns[0]!, { index: 1, user: { text: "broken" }, steps: [null as never, after as never] }, { index: 2, user: { text: "fine" }, steps: [after as never] }];
    const { el, turns } = renderTranscript(s);
    expect(turns.map((t) => t.index)).toEqual([0, 1, 2]);
    expect(el.querySelectorAll(".turn")).toHaveLength(3);
    expect(el.querySelector("#turn-1 .k-unsupported")?.textContent).toContain("couldn't be shown");
    expect(el.querySelector("#turn-2")?.textContent).toContain("after");
    expect(turns.map((t) => t.ordinal)).toEqual([1, 2, 3]);
  });

  it("keeps it out of the outline and the search, and out of views that show less", () => {
    const s = withSteps([text, { kind: "diagram", id: "d", body: "secret-looking words" }]);
    expect(renderTranscript(s).turns[0]!.items.map((i) => i.label)).toEqual(["before"]);
    expect(JSON.stringify(buildIndex(s))).not.toContain("secret-looking");
    for (const mode of ["brief", "minimal"] as const) {
      const steps = projectSession(s, mode).turns[0]!.steps;
      expect(steps.map((x) => x.kind)).toEqual(["text"]);
    }
  });
});

describe("the notice for a newer format", () => {
  const formats = { shared: "agentshare/3", viewer: "agentshare/2" };

  it("names both formats and counts what couldn't be shown, with a link to the first", () => {
    const goToFirst = vi.fn();
    const el = renderCompatNotice(formats, { count: 3, goToFirst });
    expect(el.getAttribute("role")).toBe("status");
    expect(el.querySelector(".compat-title")?.textContent).toBe("Shared with a newer agent-share");
    expect(Array.from(el.querySelectorAll("code"), (c) => c.textContent)).toEqual(["agentshare/3", "agentshare/2"]);
    expect(el.textContent).toContain("3 parts can't be shown.");
    const go = el.querySelector<HTMLButtonElement>("button.compat-go")!;
    expect(go.textContent).toBe("Jump to the first ↓");
    go.click();
    expect(goToFirst).toHaveBeenCalledOnce();
  });

  it("says 'it' for a single part", () => {
    const el = renderCompatNotice(formats, { count: 1, goToFirst: () => {} });
    expect(el.textContent).toContain("1 part can't be shown.");
    expect(el.querySelector("button.compat-go")?.textContent).toBe("Jump to it ↓");
  });

  it("has no count and no link when nothing was left out of the view", () => {
    const el = renderCompatNotice(formats, { count: 0, goToFirst: () => {} });
    expect(el.textContent).toContain("Parts of it may be missing.");
    expect(el.querySelector("button")).toBeNull();
  });
});

describe("frozen shares", () => {
  it("has a frozen share for the current format, and one directory per version it opens", () => {
    // Bumping SCHEMA_VERSION fails here until a share in the new format is frozen
    // (see tests/fixtures/shares/README.md) and, for every older version, a migration is registered.
    expect(versions).toContain(current);
    for (const v of versions) {
      expect(v).toBeLessThanOrEqual(current);
      expect(frozen(v).length).toBeGreaterThan(0);
    }
    const oldest = versions[0]!;
    for (let v = oldest; v < current; v++) expect(MIGRATIONS[v], `no migration from agentshare/${v}`).toBeTypeOf("function");
  });

  const files = versions.flatMap((v) => frozen(v).map((f) => ({ version: v, ...f })));
  it.each(files.map((f) => [`agentshare/${f.version} ${f.name}`, f] as const))("%s opens and renders in every view", async (_label, file) => {
    const raw = parsed(file.json);
    expect(raw.schema).toBe(`agentshare/${file.version}`);
    const { session, newer } = await readShare(raw);
    expect(newer).toBeUndefined();
    expect(session.schema).toBe(SCHEMA_VERSION);

    const reachable = availableModes(session.mode, !promptsUnavailableReason(session));
    expect(reachable).toContain(session.mode);
    for (const view of reachable) {
      const shown = view === session.mode ? session : projectSession(session, view);
      for (const variant of VARIANTS) {
        document.documentElement.dataset.variant = variant.id;
        const { el, turns } = renderTranscript(shown, { inlineThinking: variant.inlineThinking });
        expect(el.querySelectorAll(".entry").length, `${view}/${variant.id}`).toBeGreaterThan(0);
        expect(el.querySelectorAll(".k-unsupported"), `${view}/${variant.id}: a frozen share has nothing the viewer can't draw`).toHaveLength(0);
        renderTokenRail(shown, turns, () => {}, () => {});
        renderToc(turns, () => {}, { detail: "all", onDetail: () => {}, onClear: () => {}, index: () => buildIndex(shown) });
      }
      renderHeader(shown, { label: "test" }, {
        sharedMode: session.mode,
        view,
        setView: () => {},
        toggleTheme: () => {},
        toggleRail: () => {},
        settings: { current: () => VARIANTS[0]!, onPick: () => {}, defaults: () => ({ canSave: false, canReset: false }), saveDefault: () => {}, resetDefault: () => {} },
        share: { source: { kind: "local", name: "s.json" }, view: () => ({ ui: "", label: "" }), turn: () => undefined },
        local: false,
      });
    }
  });
});
