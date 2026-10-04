/**
 * ass-yyg0: a background subagent's final answer was cut at SUBAGENT_RESULT_CHARS (4000) in the adapter, BEFORE
 * redaction. A secret straddling char 4000 left a prefix that matches no rule and no known value, the final re-scan did
 * not flag it, and `report.blocked` stayed false. Two entry points, both Claude Code (pi has no background answers; its
 * foreground subagent result is covered in tests/truncate-before-redact.vitest.ts):
 *   - a task-notification's `<result>` (completeSubagent);
 *   - the final message of the subagent's own transcript file (setSubagentSummary).
 * Only planted fakes. The assertions run the real pipeline with the default config and look at the payload and at every
 * string the CLI report and the browse review expose; they report counts of leaked windows, never which.
 */
import { describe, expect, it } from "vitest";
import { summarizeShare } from "../src/browse/job.js";
import { parseClaudeCode } from "../src/harnesses/claude-code/parse.js";
import type { SubagentFileInput } from "../src/harnesses/shared.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { SUBAGENT_RESULT_CHARS } from "../src/modes.js";
import { prepareShare } from "../src/pipeline.js";
import { knownSecret } from "../src/redact/known-values.js";
import { formatReport } from "../src/report.js";
import type { ShareMode, SubagentStep } from "../src/schema.js";
import { ClaudeTranscript, ccUsage, fake } from "./helpers.js";

const machine = { homeDir: "/home/tester", username: "tester", hostname: "box" };
const MODES: ShareMode[] = ["full", "brief", "minimal", "prompts"];
const WINDOW = 8;
const CUT = SUBAGENT_RESULT_CHARS;
/** Well inside, close, on the cut and past it. */
const STARTS = [CUT - 100, CUT - 20, CUT - 5, CUT - 1, CUT, CUT + 1];
const LAUNCH = "toolu_launch_1";

const lead = (n: number): string => `${"the module exports add and mul. ".repeat(Math.ceil(n / 32) + 1).slice(0, n - 1)} `;

function fragments(secret: string): string[] {
  const body = secret.includes("\n") ? secret.split("\n").slice(1, -1).join("\n") : secret;
  const out: string[] = [];
  for (let i = 0; i + WINDOW <= body.length; i++) out.push(body.slice(i, i + WINDOW));
  return out;
}

const planted = () => [
  { name: "anthropic key", value: fake.anthropic(), known: false },
  { name: "github token", value: fake.github(), known: false },
  { name: "pem block", value: fake.pem(), known: false },
  { name: "known env secret", value: fake.envValue(), known: true },
];

// ── the two entry points ────────────────────────────────────────────────────────────────────────────────────────

type Entry = "notification" | "transcript summary";

const launched = (t: ClaudeTranscript): ClaudeTranscript =>
  t
    .user("describe the module")
    .assistant("m1", [{ type: "tool_use", id: LAUNCH, name: "Agent", input: { subagent_type: "general-purpose", description: "Describe mathlib", run_in_background: true } }], ccUsage(1, 1))
    .toolResult(LAUNCH, [{ type: "text", text: "Async agent launched successfully.\nagentId: a1" }], { toolUseResult: { isAsync: true, status: "async_launched", agentId: "a1", description: "d" } });

const notification = (answer: string) =>
  `<task-notification>\n<task-id>a1</task-id>\n<tool-use-id>${LAUNCH}</tool-use-id>\n<status>completed</status>\n<summary>Agent finished</summary>\n<result>${answer}</result>\n<usage><subagent_tokens>1</subagent_tokens></usage>\n</task-notification>`;

function transcript(entry: Entry, answer: string): { raw: string; subagentFiles?: SubagentFileInput[] } {
  const t = launched(new ClaudeTranscript());
  if (entry === "notification") t.user(notification(answer), { origin: { kind: "task-notification", producer: "session-task" } });
  t.assistant("m2", [{ type: "text", text: "done" }], ccUsage(1, 1));
  if (entry === "notification") return { raw: t.toJsonl() };
  const line = { type: "assistant", isSidechain: true, uuid: "sc-1", timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, 0, 1)).toISOString(), message: { id: "msg_a1", model: "claude-haiku-4-5-20251001", role: "assistant", content: [{ type: "text", text: answer }], usage: ccUsage(5, 7, 100, 50) } };
  return { raw: t.toJsonl(), subagentFiles: [{ fileName: "agent-a1.jsonl", raw: `${JSON.stringify(line)}\n`, meta: { toolUseId: LAUNCH } }] };
}

const ENTRIES: Entry[] = ["notification", "transcript summary"];

const share = (entry: Entry, answer: string, mode: ShareMode, known?: ReturnType<typeof knownSecret>) => {
  const { raw, subagentFiles } = transcript(entry, answer);
  return prepareShare(raw, { mode, config: DEFAULT_CONFIG, harness: "claude-code", machine, subagentFiles, knownSecrets: known ? [known] : [] });
};

const surfacesOf = (p: ReturnType<typeof prepareShare>): Record<string, string> => ({
  payload: p.json,
  human: formatReport(p.report, { maxFindings: Infinity }),
  json: JSON.stringify(p.report),
  browse: JSON.stringify(summarizeShare(p)),
});

const answerOf = (p: ReturnType<typeof prepareShare>): string | undefined =>
  p.session.turns.flatMap((t) => t.steps).find((s): s is SubagentStep => s.kind === "subagent")?.result?.text;

describe("a secret that straddles the cut of a background subagent's answer", () => {
  for (const entry of ENTRIES) {
    for (const mode of MODES) {
      for (const start of STARTS) {
        it.each(planted())(`${entry}: $name at char ${start} is not in the payload or any report string (${mode})`, (secret) => {
          const known = secret.known ? knownSecret(secret.value, "DEMO_SERVICE_TOKEN", "env") : undefined;
          const prepared = share(entry, `${lead(start)}${secret.value}`, mode, known);
          for (const [surface, text] of Object.entries(surfacesOf(prepared))) {
            const leaked = fragments(secret.value).filter((f) => text.includes(f));
            // Counts only: the number of leaked windows, never which.
            expect({ surface, leakedWindows: leaked.length }).toEqual({ surface, leakedWindows: 0 });
          }
          expect(prepared.report.blocked).toBe(false);
        });
      }
    }
  }

  // The loop above would also pass if the answer were never published: say that full mode does publish it, redacted.
  it.each(ENTRIES)("the answer is really published in full mode, redacted and cut (%s)", (entry) => {
    const prepared = share(entry, `${lead(CUT - 100)}${fake.github()} and then some more text after it`, "full");
    const text = answerOf(prepared)!;
    expect(text).toContain("[REDACTED:");
    expect(prepared.session.turns.flatMap((t) => t.steps).find((s) => s.kind === "subagent")).toMatchObject({ async: true });
    for (const mode of ["brief", "minimal", "prompts"] as const) expect(answerOf(share(entry, "short answer", mode))).toBeUndefined();
  });

  // The github marker is about 20 characters: a secret starting 1-18 characters before the cut leaves a marker that spans it.
  it.each(ENTRIES)("a [REDACTED:..] token that spans the cut is dropped whole (%s)", (entry) => {
    for (const start of [CUT - 18, CUT - 12, CUT - 6, CUT - 2]) {
      const text = answerOf(share(entry, `${lead(start)}${fake.github()}`, "full"))!;
      const [kept, rest] = text.split("\n… [truncated ");
      expect(rest).toMatch(/^\d+ chars\]$/);
      expect(kept!.length).toBeLessThanOrEqual(CUT);
      expect(kept).not.toContain("[");
      expect(kept).not.toContain("REDACTED");
    }
  });

  it.each(ENTRIES)("an ordinary long answer is still cut at %s's 4000 characters and says from how many", (entry) => {
    const long = `${"word ".repeat(1_200)}end`;
    const prepared = share(entry, long, "full");
    const step = prepared.session.turns.flatMap((t) => t.steps).find((s): s is SubagentStep => s.kind === "subagent")!;
    expect(step.result?.truncatedFrom).toBe(long.length);
    expect(step.result?.text.startsWith("word ".repeat(CUT / 5))).toBe(true);
    expect(step.result?.text.length).toBeLessThan(CUT + 60);
    // A short answer is untouched.
    expect(answerOf(share(entry, "all good", "full"))).toBe("all good");
  });

  it("a smaller maxToolChars still wins; a foreground subagent answer keeps the maxToolChars cap", () => {
    const { raw, subagentFiles } = transcript("notification", "x".repeat(1_000));
    const small = prepareShare(raw, { mode: "full", config: { ...DEFAULT_CONFIG, maxToolChars: 300 }, harness: "claude-code", machine, subagentFiles, knownSecrets: [] });
    expect(answerOf(small)).toMatch(/^x{300}\n… \[truncated 700 chars\]$/);

    const foreground = new ClaudeTranscript()
      .user("go")
      .assistant("m1", [{ type: "tool_use", id: "t1", name: "Agent", input: { subagent_type: "Explore", description: "look" } }], ccUsage(1, 1))
      .toolResult("t1", "y".repeat(CUT + 500))
      .assistant("m2", [{ type: "text", text: "done" }], ccUsage(1, 1))
      .toJsonl();
    const fg = prepareShare(foreground, { mode: "full", config: DEFAULT_CONFIG, harness: "claude-code", machine, knownSecrets: [] });
    expect(answerOf(fg)).toBe("y".repeat(CUT + 500));
  });

  it("a transcript summary on a step that was not launched in the background keeps the maxToolChars cap, and a secret at that cut is not published", () => {
    const summary = (answer: string) => {
      const t = new ClaudeTranscript()
        .user("go")
        .assistant("m1", [{ type: "tool_use", id: LAUNCH, name: "Agent", input: { subagent_type: "Explore", description: "look" } }], ccUsage(1, 1))
        .assistant("m2", [{ type: "text", text: "done" }], ccUsage(1, 1));
      const line = { type: "assistant", isSidechain: true, uuid: "sc-1", timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, 0, 1)).toISOString(), message: { id: "msg_a1", model: "claude-haiku-4-5-20251001", role: "assistant", content: [{ type: "text", text: answer }], usage: ccUsage(5, 7, 100, 50) } };
      return { raw: t.toJsonl(), subagentFiles: [{ fileName: "agent-a1.jsonl", raw: `${JSON.stringify(line)}\n`, meta: { toolUseId: LAUNCH } }] };
    };
    const run = (answer: string) => {
      const { raw, subagentFiles } = summary(answer);
      return prepareShare(raw, { mode: "full", config: DEFAULT_CONFIG, harness: "claude-code", machine, subagentFiles, knownSecrets: [] });
    };
    const step = (p: ReturnType<typeof prepareShare>) => p.session.turns.flatMap((t) => t.steps).find((s): s is SubagentStep => s.kind === "subagent")!;

    const long = "w".repeat(CUT + 500);
    expect(step(run(long)).async).toBeUndefined();
    expect(step(run(long)).result).toEqual({ text: long }); // not cut at 4000

    const secret = fake.github();
    const prepared = run(`${lead(DEFAULT_CONFIG.maxToolChars - 5)}${secret}`);
    expect(step(prepared).result?.truncatedFrom).toBeGreaterThan(DEFAULT_CONFIG.maxToolChars);
    for (const text of Object.values(surfacesOf(prepared))) expect(fragments(secret).filter((f) => text.includes(f))).toHaveLength(0);
    expect(prepared.report.blocked).toBe(false);
  });

  it("the adapter keeps the answer whole, so the cap lives in one place (after redaction)", () => {
    for (const entry of ENTRIES) {
      const long = "z".repeat(CUT + 500);
      const { raw, subagentFiles } = transcript(entry, long);
      const { session } = parseClaudeCode(raw, { subagentFiles });
      const step = session.turns.flatMap((t) => t.steps).find((s): s is SubagentStep => s.kind === "subagent")!;
      expect(step.result).toEqual({ text: long });
    }
  });
});
