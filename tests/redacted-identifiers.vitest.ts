// @vitest-environment jsdom
/**
 * Identifiers the transcript supplies stay distinguishable once redacted, and model ids are redacted at all.
 *
 * ass-lka8: two different secret-shaped response ids both became `[REDACTED:<rule>]`, and the viewer, which joins a
 * response to its step by id, attributed the second response to the first step. A redacted id now carries a surrogate
 * (`[REDACTED:rule]`, `[REDACTED:rule#2]`, ...), the same for the same value everywhere and never the same for two.
 * ass-gmih: the model ids (`session.models`, `responses[].model`, the keys of the stats keyed by model) were published
 * as they were. They go through the same identifier redaction, so one secret-shaped model id is one surrogate in all of them.
 *
 * Everything here runs the real pipeline over transcripts with planted fake secrets; the viewer half runs the real
 * transcript renderer over the payload that came out.
 */
import { describe, expect, it } from "vitest";
import { baseSession } from "../src/harnesses/shared.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { prepareShare, type PrepareOptions } from "../src/pipeline.js";
import { Redactor, redactSession } from "../src/redact/index.js";
import { formatReport } from "../src/report.js";
import type { NormalizedSession, ShareMode } from "../src/schema.js";
import { ClaudeTranscript, PiTranscript, ccUsage, fake, piUsage, randomish } from "./helpers.js";

(globalThis as { __OVERSHARE_SOURCES__?: Record<string, string> }).__OVERSHARE_SOURCES__ = {};
const { renderTranscript } = await import("../viewer/src/transcript.ts");

const machine = { homeDir: "/home/tester", username: "tester", hostname: "box" };
const prepare = (raw: string, mode: ShareMode = "full", extra: Partial<PrepareOptions> = {}) =>
  prepareShare(raw, { mode, config: DEFAULT_CONFIG, machine, knownSecrets: [], ...extra });

/** Two different tokens of the same shape, so both get the same rule name. */
const ghp = (seed: number) => ["gh", "p_", randomish(36, seed)].join("");

describe("Redactor.redactIdentifier surrogates", () => {
  const r = () => new Redactor({ ...machine });

  it("gives each distinct redacted value its own token, the same one every time", () => {
    const redactor = r();
    const [a, b, c] = [ghp(1), ghp(2), ghp(3)];
    const first = redactor.redactIdentifier(a);
    expect(first).toBe("[REDACTED:github-v2]");
    expect(redactor.redactIdentifier(b)).toBe("[REDACTED:github-v2#2]");
    expect(redactor.redactIdentifier(c)).toBe("[REDACTED:github-v2#3]");
    // Stable: asked again, in any order, from any field, a value keeps its token.
    expect(redactor.redactIdentifier(b)).toBe("[REDACTED:github-v2#2]");
    expect(redactor.redactIdentifier(a)).toBe(first);
  });

  it("numbers per rule, and keeps the text around the secret", () => {
    const redactor = r();
    expect(redactor.redactIdentifier(`msg:${ghp(1)}`)).toBe("msg:[REDACTED:github-v2]");
    expect(redactor.redactIdentifier(`msg:${ghp(2)}`)).toBe("msg:[REDACTED:github-v2#2]");
    expect(redactor.redactIdentifier(fake.aws())).toBe("[REDACTED:aws-access_keys]");
  });

  it("leaves ordinary ids alone and never numbers them", () => {
    const redactor = r();
    for (const id of ["claude-opus-5-5", "msg_01plain", "toolu_01abc", "aaaaaaaa-0000-0000-0000-000000000000", ""]) expect(redactor.redactIdentifier(id)).toBe(id);
    expect(redactor.redactIdentifier(ghp(1))).toBe("[REDACTED:github-v2]"); // the first redacted value is still the first
  });

  it("the token says nothing about the value: no part of it, only the count of values seen", () => {
    const redactor = r();
    const secrets = [ghp(1), ghp(2)];
    const out = secrets.map((s) => redactor.redactIdentifier(s));
    expect(out.join("")).not.toMatch(/ghp_|[A-Za-z0-9]{20}/);
  });

  it("redactIdentifierKeys redacts keys with the same surrogates as values and never merges two entries", () => {
    const redactor = r();
    const [a, b] = [ghp(1), ghp(2)];
    expect(redactor.redactIdentifier(b)).toBe("[REDACTED:github-v2]"); // b was seen first, as a value
    const out = redactor.redactIdentifierKeys({ [a]: 1, [b]: 2, "claude-opus-5-5": 3 });
    expect(out).toEqual({ "[REDACTED:github-v2#2]": 1, "[REDACTED:github-v2]": 2, "claude-opus-5-5": 3 });
  });

  it("a key that is an own `__proto__` stays an own key", () => {
    const record = JSON.parse('{"__proto__": 1, "claude-opus-5-5": 2}') as Record<string, number>;
    const out = r().redactIdentifierKeys(record);
    expect(Object.keys(out)).toEqual(["__proto__", "claude-opus-5-5"]);
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(JSON.stringify(out)).toBe('{"__proto__":1,"claude-opus-5-5":2}');
  });

  describe("an id that is already shaped like a token (a transcript that was redacted before)", () => {
    const literals = ["[REDACTED:github-v2]", "[REDACTED:github-v2#2]", "[REDACTED:identifier]"];

    it("never equals the surrogate of a secret, whichever comes first", () => {
      for (const literal of literals) {
        for (const order of ["literal-first", "literal-last"] as const) {
          const redactor = r();
          const secrets = [ghp(1), ghp(2), ghp(3)];
          const inputs = order === "literal-first" ? [literal, ...secrets] : [...secrets, literal];
          const out = inputs.map((id) => redactor.redactIdentifier(id));
          expect(new Set(out).size, `${order} ${literal}: ${out.join(" ")}`).toBe(inputs.length);
          // Each value keeps its token on every later call.
          expect(inputs.map((id) => redactor.redactIdentifier(id))).toEqual(out);
        }
      }
    });

    it("is replaced by a token of ours, and a second different one by another", () => {
      const redactor = r();
      expect(redactor.redactIdentifier("[REDACTED:github-v2#2]")).toBe("[REDACTED:identifier]");
      expect(redactor.redactIdentifier("[REDACTED:aws]")).toBe("[REDACTED:identifier#2]");
    });

    it("keys and values agree: the same raw id is the same token as a key and as a value", () => {
      const redactor = r();
      const [a, b] = [ghp(1), ghp(2)];
      const raw = ["[REDACTED:github-v2]", a, b];
      const values = raw.map((id) => redactor.redactIdentifier(id));
      const keys = Object.keys(redactor.redactIdentifierKeys(Object.fromEntries(raw.map((id, i) => [id, i]))));
      expect(keys).toEqual(values);
      expect(new Set(keys).size).toBe(3);
    });

    it("does not count as a finding: it is not a secret", () => {
      const redactor = r();
      redactor.redactIdentifier("[REDACTED:github-v2]");
      expect(redactor.findings).toEqual([]);
      expect(redactor.secretCount).toBe(0);
    });
  });
});

describe("two secret-shaped response ids (ass-lka8)", () => {
  const [one, two] = [ghp(11), ghp(12)];

  /** A tool call on the first response and the closing text on the second, so they are two steps in every mode that keeps text. */
  const claude = () =>
    new ClaudeTranscript("aaaaaaaa-0000-0000-0000-000000000000", "/home/tester/work/demo")
      .user("run it")
      .assistant(one, [{ type: "tool_use", id: "b1", name: "Bash", input: { command: "ls" } }], ccUsage(10, 1))
      .toolResult("b1", "ok")
      .assistant(two, [{ type: "text", text: "done" }], ccUsage(20, 2))
      .toJsonl();

  /** pi's response id is the entry id: user e1, call e2, result e3, closing text e4. */
  const pi = () => {
    const raw = new PiTranscript("01a0aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee", "/home/tester/work/demo")
      .user("run it")
      .assistant([{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } }], piUsage(10, 1))
      .toolResult("c1", "bash", "ok")
      .assistant([{ type: "text", text: "done" }], piUsage(20, 2))
      .toJsonl()
      .replaceAll('"e2"', `"${one}"`)
      .replaceAll('"e4"', `"${two}"`);
    expect(raw).toContain(one);
    return raw;
  };

  const HARNESSES = [
    ["Claude Code", claude],
    ["pi", pi],
  ] as const;

  for (const [name, build] of HARNESSES) {
    for (const mode of ["full", "brief"] as const) {
      it(`${name}, ${mode} mode: the two ids stay two, without exposing either, and each response links to its own step`, () => {
        const p = prepare(build(), mode);
        expect(p.json).not.toContain(one);
        expect(p.json).not.toContain(two);
        expect(p.json).not.toContain(one.slice(8, 30));
        expect(p.json).not.toContain(two.slice(8, 30));
        expect(p.report.blocked).toBe(false);

        const ids = p.session.responses.map((r) => r.id);
        expect(ids).toEqual(["[REDACTED:github-v2]", "[REDACTED:github-v2#2]"]);

        // The steps carry the same two tokens, whichever way the mode shapes them.
        const stepIds = p.session.turns.flatMap((t) => t.steps.flatMap((s) => (s.kind === "toolGroup" ? s.responseIds : s.responseId ? [s.responseId] : [])));
        expect(new Set(stepIds)).toEqual(new Set(ids));

        // The viewer joins them: each response lands on a step, and not the same one.
        const rendered = renderTranscript(JSON.parse(p.json) as NormalizedSession).turns;
        const links = ids.map((id) => rendered[0]!.responseSteps.get(id));
        expect(links.every((l) => l !== undefined)).toBe(true);
        expect(new Set(links).size).toBe(2);
      });
    }

    it(`${name}: the surrogate appears on no report surface`, () => {
      const p = prepare(build());
      for (const text of [formatReport(p.report, { maxFindings: Infinity }), JSON.stringify(p.report)]) {
        expect(text).not.toContain(one.slice(8, 30));
        expect(text).not.toContain(two.slice(8, 30));
      }
    });
  }

  it("the same secret as the call's response id on several steps is one token", () => {
    // Two blocks of one response (a text and a tool call): one id, one token, one entry in `responses`.
    const raw = new ClaudeTranscript("aaaaaaaa-0000-0000-0000-000000000000", "/home/tester/work/demo")
      .user("run it")
      .assistant(one, [{ type: "text", text: "on it" }, { type: "tool_use", id: "b1", name: "Bash", input: { command: "ls" } }], ccUsage(10, 1))
      .toolResult("b1", "ok")
      .toJsonl();
    const p = prepare(raw);
    expect(p.session.responses.map((r) => r.id)).toEqual(["[REDACTED:github-v2]"]);
    const stepIds = p.session.turns.flatMap((t) => t.steps.map((s) => s.responseId).filter(Boolean));
    expect(new Set(stepIds)).toEqual(new Set(["[REDACTED:github-v2]"]));
  });

  it("a response id that is already a token cannot take another response's place, whichever comes first", () => {
    const literal = "[REDACTED:github-v2#2]";
    for (const ids of [[literal, one, two], [one, two, literal]]) {
      const t = new ClaudeTranscript("aaaaaaaa-0000-0000-0000-000000000000", "/home/tester/work/demo").user("go");
      ids.forEach((id, i) => t.assistant(id, [{ type: "text", text: `reply ${i}` }], ccUsage(10 + i, 1)));
      const p = prepare(t.toJsonl());
      const redacted = p.session.responses.map((r) => r.id);
      expect(new Set(redacted).size, redacted.join(" ")).toBe(3);
      const rendered = renderTranscript(JSON.parse(p.json) as NormalizedSession).turns;
      expect(new Set(redacted.map((id) => rendered[0]!.responseSteps.get(id))).size).toBe(3);
    }
  });

  it("ordinary response ids are unchanged", () => {
    const raw = new ClaudeTranscript("aaaaaaaa-0000-0000-0000-000000000000", "/home/tester/work/demo")
      .user("run it")
      .assistant("msg_01aaa", [{ type: "text", text: "one" }], ccUsage(1, 1))
      .assistant("msg_01bbb", [{ type: "text", text: "two" }], ccUsage(1, 1))
      .toJsonl();
    const p = prepare(raw);
    expect(p.session.responses.map((r) => r.id)).toEqual(["msg_01aaa", "msg_01bbb"]);
    expect(p.report.findings).toEqual([]);
  });
});

describe("model ids (ass-gmih)", () => {
  const [m1, m2] = [fake.aws(), ghp(21)];
  const cost = { input: 0.001, output: 0.001, cacheRead: 0.0001, cacheWrite: 0, total: 0.0021 };

  const claude = (a: string, b: string) =>
    new ClaudeTranscript("aaaaaaaa-0000-0000-0000-000000000000", "/home/tester/work/demo")
      .user("one")
      .assistant("m1", [{ type: "text", text: "a" }], ccUsage(1, 1), a)
      .user("two")
      .assistant("m2", [{ type: "text", text: "b" }], ccUsage(1, 1), b)
      .toJsonl();

  const pi = (a: string, b: string) =>
    new PiTranscript("01a0aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee", "/home/tester/work/demo")
      .user("one")
      .assistant([{ type: "text", text: "a" }], { ...piUsage(100, 10, 100, 0), cost }, { model: a })
      .user("two")
      .assistant([{ type: "text", text: "b" }], { ...piUsage(100, 10, 100, 0), cost }, { model: b })
      .toJsonl();

  const MODES: ShareMode[] = ["full", "brief", "minimal", "prompts"];

  for (const [name, build] of [["Claude Code", claude], ["pi", pi]] as const) {
    for (const mode of MODES) {
      if (name === "pi" && mode === "prompts") continue; // pi's prompts mode needs input provenance; the models are not mode dependent
      it(`${name}, ${mode} mode: secret-shaped model ids reach neither the payload nor the report, and block nothing`, () => {
        const p = prepare(build(m1, m2), mode);
        for (const secret of [m1, m2]) {
          expect(p.json).not.toContain(secret);
          expect(p.json).not.toContain(secret.slice(8, 20));
          for (const text of [formatReport(p.report, { maxFindings: Infinity }), JSON.stringify(p.report)]) expect(text).not.toContain(secret.slice(8, 20));
        }
        expect(p.session.models).toEqual(["[REDACTED:aws-access_keys]", "[REDACTED:github-v2]"]);
        expect(p.session.responses.map((r) => r.model)).toEqual(p.session.models);
        expect(p.report.blocked).toBe(false); // redacted at the source, not caught by the re-scan
        expect(p.report.rescan).toEqual([]);
        expect(p.report.suspicious).toEqual([]);
      });
    }
  }

  it("pi: the keys of the per-model rates are redacted in the payload, one entry per model", () => {
    const p = prepare(pi(m1, ghp(22)));
    expect(Object.keys(p.session.stats.rates ?? {}).sort()).toEqual(["[REDACTED:aws-access_keys]", "[REDACTED:github-v2]"]);
    expect(p.json).not.toContain(m1);
  });

  it("two models of the same shape stay two keys and two values", () => {
    const p = prepare(pi(ghp(23), ghp(24)));
    expect(p.session.models).toEqual(["[REDACTED:github-v2]", "[REDACTED:github-v2#2]"]);
    expect(Object.keys(p.session.stats.rates ?? {}).sort()).toEqual(["[REDACTED:github-v2#2]", "[REDACTED:github-v2]"].sort());
  });

  it("ordinary model ids are unchanged, in the values and in the keys", () => {
    for (const mode of MODES) {
      const p = prepare(claude("claude-opus-5-5", "claude-sonnet-5-5"), mode);
      expect(p.session.models).toEqual(["claude-opus-5-5", "claude-sonnet-5-5"]);
      expect(p.session.responses.map((r) => r.model)).toEqual(["claude-opus-5-5", "claude-sonnet-5-5"]);
      expect(p.report.findings, mode).toEqual([]);
    }
    const q = prepare(pi("claude-opus-5-5", "gpt-6.1-sol"));
    expect(Object.keys(q.session.stats.rates ?? {}).sort()).toEqual(["claude-opus-5-5", "gpt-6.1-sol"]);
  });

  it("a text step's model and a subagent's models get the same surrogate as the session's", () => {
    const session = baseSession("claude-code", "s1");
    session.models = [m1];
    session.turns = [
      {
        index: 0,
        user: { text: "go", authored: true },
        steps: [
          { kind: "text", id: "t1", text: "hi", model: m1 },
          { kind: "subagent", id: "s1", tool: "Task", agents: ["x"], usage: { models: [m2, m1] } },
        ],
      },
    ];
    const out = redactSession(session, new Redactor({ ...machine }));
    expect(out.models).toEqual(["[REDACTED:aws-access_keys]"]);
    const [text, sub] = out.turns[0]!.steps;
    expect(text).toMatchObject({ model: "[REDACTED:aws-access_keys]" });
    expect(sub).toMatchObject({ usage: { models: ["[REDACTED:github-v2]", "[REDACTED:aws-access_keys]"] } });
    expect(JSON.stringify(out)).not.toContain(m1);
    expect(JSON.stringify(out)).not.toContain(m2);
  });

  it("the subagent stats keyed by model are redacted too, whole and unlinked", () => {
    const session = baseSession("claude-code", "s1");
    const totals = (byModel: Record<string, { responses: number; tokens: NormalizedSession["stats"]["tokens"] }>) => ({
      responses: 2,
      tokens: session.stats.tokens,
      agents: 1,
      byModel,
    });
    const u = { responses: 1, tokens: session.stats.tokens };
    session.stats.subagentUsage = { ...totals({ [m1]: u, [m2]: u, "claude-opus-5-5": u }), unlinked: totals({ [m1]: u }) };
    const out = redactSession(session, new Redactor({ ...machine }));
    expect(Object.keys(out.stats.subagentUsage!.byModel)).toEqual(["[REDACTED:aws-access_keys]", "[REDACTED:github-v2]", "claude-opus-5-5"]);
    expect(Object.keys(out.stats.subagentUsage!.unlinked!.byModel)).toEqual(["[REDACTED:aws-access_keys]"]);
    expect(JSON.stringify(out)).not.toContain(m1);
    expect(JSON.stringify(out)).not.toContain(m2);
  });
});
