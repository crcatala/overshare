/**
 * ass-7x3c: text that was cut BEFORE redaction in more places than the title (ass-ahh1). A secret that straddles the
 * cut leaves a prefix that matches no rule and no known value; the final re-scan does not flag it either, so
 * `report.blocked` stayed false and 2-3 eight-character windows of the secret were published. Four sites:
 *   - a tool step's `summary` (and a tool group's `commands` in brief mode), first line cut at 160 in the adapter;
 *   - a subagent's `description`, derived from the prompt/task/mission, cut at 160 in the adapter;
 *   - a tool input's strings and a tool result, cut at `maxToolChars` in the projection;
 *   - a subagent's result, cut at `maxToolChars` in the projection.
 * Only planted fakes. The assertions run the real pipeline and look at the payload and at every string the CLI report
 * and the browse review expose; they report counts of leaked windows, never which.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { viewFromSession, summarizeShare } from "../src/browse/job.js";
import { parseSession } from "../src/harnesses/index.js";
import { capRedacted, cutPoint } from "../src/cap.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { capToolText } from "../src/modes.js";
import { prepareShare, SUMMARY_MAX } from "../src/pipeline.js";
import { knownSecret } from "../src/redact/known-values.js";
import { formatReport } from "../src/report.js";
import { PI_INPUT_PROVENANCE_TYPE, type HarnessName, type NormalizedSession, type ShareMode, type Step } from "../src/schema.js";
import { ClaudeTranscript, PiTranscript, ccUsage, fake, piUsage } from "./helpers.js";

const machine = { homeDir: "/home/tester", username: "tester", hostname: "box" };
const MODES: ShareMode[] = ["full", "brief", "minimal", "prompts"];
const WINDOW = 8;
/** A small cap keeps the fixtures small; the default 20000 is exercised once below. */
const MAX = 200;
const CONFIG = { ...DEFAULT_CONFIG, maxToolChars: MAX };

interface Planted {
  name: string;
  value: string;
  known?: boolean;
}
const planted = (): Planted[] => [
  { name: "anthropic key", value: fake.anthropic() },
  { name: "github token", value: fake.github() },
  { name: "pem block", value: fake.pem() },
  { name: "known env secret", value: fake.envValue(), known: true },
];

/** `n` characters of ordinary words, ending in a space, so a secret appended after it starts at exactly that index. */
const lead = (n: number): string => `${"please deploy the app and ".repeat(Math.ceil(n / 26) + 1).slice(0, n - 1)} `;

/** The parts of a secret that must never appear: every window of it, but not a PEM's public header and footer lines. */
function fragments(secret: string): string[] {
  const body = secret.includes("\n") ? secret.split("\n").slice(1, -1).join("\n") : secret;
  const out: string[] = [];
  for (let i = 0; i + WINDOW <= body.length; i++) out.push(body.slice(i, i + WINDOW));
  return out;
}

// ── transcripts: one tool call (or subagent launch) per harness, the text under test in the named place ────────────

type Site = "summary" | "description" | "input" | "result" | "subagent-result";

const SESSION = "aaaaaaaa-0000-0000-0000-000000000000";
const CWD = "/home/tester/work/demo";

function claude(site: Site, text: string, variant = ""): string {
  const t = new ClaudeTranscript(SESSION, CWD).user("run it");
  if (site === "summary") t.assistant("m1", [{ type: "tool_use", id: "t1", name: "Bash", input: { command: `${text}\necho done` } }], ccUsage(1, 1)).toolResult("t1", "ok");
  else if (site === "description") {
    const input = variant === "task" ? { subagent_type: "Explore", task: text } : { subagent_type: "Explore", prompt: `${text}\nand report back` };
    t.assistant("m1", [{ type: "tool_use", id: "t1", name: variant === "task" ? "Task" : "Agent", input }], ccUsage(1, 1)).toolResult("t1", "found it");
  } else if (site === "input") t.assistant("m1", [{ type: "tool_use", id: "t1", name: "Write", input: { file_path: "src/out.txt", content: text, nested: { list: [text] } } }], ccUsage(1, 1)).toolResult("t1", "ok");
  else if (site === "result") t.assistant("m1", [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }], ccUsage(1, 1)).toolResult("t1", text);
  else t.assistant("m1", [{ type: "tool_use", id: "t1", name: "Agent", input: { subagent_type: "Explore", description: "look around" } }], ccUsage(1, 1)).toolResult("t1", text);
  return t.assistant("m2", [{ type: "text", text: "done" }], ccUsage(1, 1)).toJsonl();
}

function pi(site: Site, text: string, variant = ""): string {
  const t = new PiTranscript();
  const prompt = "run it";
  const timestamp = 1_700_000_000_000;
  // Authored-input provenance, so prompts mode is available for pi too.
  t.entry("custom", { customType: PI_INPUT_PROVENANCE_TYPE, data: { version: 1, text: prompt, source: "interactive", messageTimestamp: timestamp, messageHash: createHash("sha256").update(prompt).digest("hex") } });
  t.entry("message", { message: { role: "user", content: [{ type: "text", text: prompt }], timestamp } });
  const call = (name: string, args: Record<string, unknown>) => t.assistant([{ type: "toolCall", id: "c1", name, arguments: args }], piUsage(1, 1));
  if (site === "summary") call("bash", { command: `${text}\necho done` }).toolResult("c1", "bash", "ok");
  else if (site === "description") {
    const args = variant === "mission" ? { agent: "scout", mission: text } : { agent: "scout", task: text };
    call("subagent", args).toolResult("c1", "subagent", "found it", { mode: "single" });
  } else if (site === "input") call("write", { path: "src/out.txt", content: text, nested: { list: [text] } }).toolResult("c1", "write", "ok");
  else if (site === "result") call("bash", { command: "ls" }).toolResult("c1", "bash", text);
  else call("subagent", { agent: "scout", task: "look around" }).toolResult("c1", "subagent", text, { mode: "single" });
  return t.assistant([{ type: "text", text: "done" }], piUsage(1, 1)).toJsonl();
}

const ADAPTERS: Array<[HarnessName, typeof claude]> = [
  ["claude-code", claude],
  ["pi", pi],
];

/** Per site: the variants to run, where the cut falls, and the fixture's text before the secret. */
const SITES: Array<{ site: Site; variants: Record<HarnessName, string[]>; cut: number; starts: number[] }> = [
  // Cut at 160 (159 characters and an ellipsis): well inside, close, on it and past it.
  { site: "summary", variants: { "claude-code": [""], pi: [""] }, cut: SUMMARY_MAX, starts: [100, 140, 150, 155, 159, 160] },
  { site: "description", variants: { "claude-code": ["", "task"], pi: ["", "mission"] }, cut: SUMMARY_MAX, starts: [100, 140, 150, 155, 159, 160] },
  { site: "input", variants: { "claude-code": [""], pi: [""] }, cut: MAX, starts: [120, 160, 180, 195, 199, 200] },
  { site: "result", variants: { "claude-code": [""], pi: [""] }, cut: MAX, starts: [120, 160, 180, 195, 199, 200] },
  { site: "subagent-result", variants: { "claude-code": [""], pi: [""] }, cut: MAX, starts: [120, 160, 180, 195, 199, 200] },
];

/** The payload and every string the CLI report and the browse review expose, as in tests/title-secret-prefix.vitest.ts. */
function surfacesOf(prepared: ReturnType<typeof prepareShare>): Record<string, string> {
  return {
    payload: prepared.json,
    human: formatReport(prepared.report, { maxFindings: Infinity }),
    json: JSON.stringify(prepared.report),
    browse: JSON.stringify(summarizeShare(prepared)),
  };
}

/** Every step of the published session, flattened. */
const stepsOf = (s: NormalizedSession): Step[] => s.turns.flatMap((t) => t.steps);

describe("a secret that straddles a cut that used to run before redaction", () => {
  for (const { site, variants, starts } of SITES) {
    for (const [harness, build] of ADAPTERS) {
      for (const variant of variants[harness]) {
        for (const mode of MODES) {
          for (const start of starts) {
            it.each(planted())(`${site}${variant ? `/${variant}` : ""}: $name at char ${start} is not in the payload or any report string (${harness}, ${mode})`, (secret) => {
              const prepared = prepareShare(build(site, `${lead(start)}${secret.value}`, variant), {
                mode,
                config: CONFIG,
                harness,
                machine,
                knownSecrets: secret.known ? [knownSecret(secret.value, "DEMO_SERVICE_TOKEN", "env")] : [],
              });
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
    }
  }

  // The loop above would also pass if a mode published nothing at the site: say where each mode does publish it.
  it.each(ADAPTERS)("the sites are really published where the modes say they are (%s)", (harness, build) => {
    const text = (n: number, secret: string) => `${lead(n)}${secret}`;
    const run = (site: Site, mode: ShareMode, variant = "") => prepareShare(build(site, text(60, fake.github()), variant), { mode, config: CONFIG, harness, machine, knownSecrets: [] });
    const has = (site: Site, mode: ShareMode, variant?: string) => {
      const p = run(site, mode, variant);
      const steps = stepsOf(p.session);
      const marked = (s: string | undefined) => /\[REDACTED:/.test(s ?? "");
      if (site === "summary") return steps.some((s) => (s.kind === "tool" && marked(s.summary)) || (s.kind === "toolGroup" && s.commands.some(marked)));
      if (site === "description") return steps.some((s) => s.kind === "subagent" && marked(s.description));
      if (site === "input") return steps.some((s) => s.kind === "tool" && marked(JSON.stringify(s.input)));
      if (site === "result") return steps.some((s) => s.kind === "tool" && marked(s.result?.text));
      return steps.some((s) => s.kind === "subagent" && marked(s.result?.text));
    };
    const expected: Record<Site, ShareMode[]> = {
      summary: ["full", "brief"], // minimal keeps no commands
      description: ["full", "brief", "minimal"],
      input: ["full"],
      result: ["full"],
      "subagent-result": ["full"],
    };
    for (const [site, modes] of Object.entries(expected) as Array<[Site, ShareMode[]]>) {
      for (const mode of MODES) expect({ site, mode, published: has(site, mode) }).toEqual({ site, mode, published: modes.includes(mode) });
    }
  });

  // ── the marker that replaces a secret spans the cut ──────────────────────────────────────────────────────────────

  describe("a [REDACTED:..] token that spans the cut is dropped whole", () => {
    // The github marker is about 20 characters: a secret starting 1-18 characters before the cut leaves a marker that spans it.
    const spanning = (cut: number) => [cut - 18, cut - 12, cut - 6, cut - 2];

    for (const [harness, build] of ADAPTERS) {
      it.each(spanning(SUMMARY_MAX - 1))(`summary (${harness}): secret at char %i`, (start) => {
        const prepared = prepareShare(build("summary", `${lead(start)}${fake.github()}`), { mode: "full", config: CONFIG, harness, machine, knownSecrets: [] });
        const summary = stepsOf(prepared.session).flatMap((s) => (s.kind === "tool" ? [s.summary] : []))[0]!;
        expect(summary.length).toBeLessThanOrEqual(SUMMARY_MAX);
        expect(summary.endsWith("…")).toBe(true);
        expect(summary).not.toContain("[");
        expect(summary).not.toContain("REDACTED");
      });

      it.each(spanning(SUMMARY_MAX - 1))(`brief command (${harness}): secret at char %i`, (start) => {
        const prepared = prepareShare(build("summary", `${lead(start)}${fake.github()}`), { mode: "brief", config: CONFIG, harness, machine, knownSecrets: [] });
        const commands = stepsOf(prepared.session).flatMap((s) => (s.kind === "toolGroup" ? s.commands : []));
        expect(commands).toHaveLength(1);
        expect(commands[0]!.endsWith("…")).toBe(true);
        expect(commands[0]).not.toContain("REDACTED");
      });

      it.each(spanning(SUMMARY_MAX - 1))(`description (${harness}): secret at char %i`, (start) => {
        const prepared = prepareShare(build("description", `${lead(start)}${fake.github()}`), { mode: "minimal", config: CONFIG, harness, machine, knownSecrets: [] });
        const description = stepsOf(prepared.session).flatMap((s) => (s.kind === "subagent" ? [s.description ?? ""] : []))[0]!;
        expect(description.length).toBeLessThanOrEqual(SUMMARY_MAX);
        expect(description.endsWith("…")).toBe(true);
        expect(description).not.toContain("[");
        expect(description).not.toContain("REDACTED");
      });

      for (const site of ["result", "input", "subagent-result"] as const) {
        it.each(spanning(MAX))(`${site} (${harness}): secret at char %i`, (start) => {
          const prepared = prepareShare(build(site, `${lead(start)}${fake.github()}`), { mode: "full", config: CONFIG, harness, machine, knownSecrets: [] });
          const texts = stepsOf(prepared.session).flatMap((s): string[] => {
            if (s.kind === "tool" && site === "result") return [s.result?.text ?? ""];
            if (s.kind === "tool" && site === "input") return [(s.input as { content: string }).content, (s.input as { nested: { list: string[] } }).nested.list[0]!];
            if (s.kind === "subagent" && site === "subagent-result") return [s.result?.text ?? ""];
            return [];
          });
          expect(texts.length).toBeGreaterThan(0);
          for (const text of texts) {
            const [kept, rest] = text.split("\n… [truncated ");
            expect(rest).toMatch(/^\d+ chars\]$/);
            expect(kept!.length).toBeLessThanOrEqual(MAX);
            expect(kept).not.toContain("[");
            expect(kept).not.toContain("REDACTED");
          }
          // `truncatedFrom` still says the text was cut.
          if (site !== "input") expect(stepsOf(prepared.session).some((s) => (s.kind === "tool" || s.kind === "subagent") && (s.result?.truncatedFrom ?? 0) > MAX)).toBe(true);
        });
      }
    }
  });

  it("a token that ends exactly at the cut is kept whole", () => {
    const marker = "[REDACTED:github-v2]";
    expect(capRedacted(`${"a".repeat(SUMMARY_MAX - 1 - marker.length)}${marker}tail beyond the cut`, SUMMARY_MAX)).toBe(`${"a".repeat(SUMMARY_MAX - 1 - marker.length)}${marker}…`);
    const text = `${"a".repeat(MAX - marker.length)}${marker}${"b".repeat(50)}`;
    expect(cutPoint(text, MAX)).toBe(MAX);
  });

  it("cutPoint and capRedacted never split a token, whatever its length or kind, at any cut position", () => {
    for (const marker of ["[REDACTED:private-key-block]", `[REDACTED:${"x".repeat(64)}]`, "[REDACTED]", "[email]", "[user]", "[host]"]) {
      for (let start = 40; start <= 80; start++) {
        const text = `${"a".repeat(start)}${marker}${"b".repeat(60)}`;
        for (let end = 41; end <= 120; end++) {
          const cut = cutPoint(text, end);
          expect(cut).toBeLessThanOrEqual(end);
          const kept = text.slice(0, cut);
          expect(kept.split("[").length).toBe(kept.split("]").length); // every opened token is closed
        }
        const capped = capRedacted(text, 80);
        expect(capped.length).toBeLessThanOrEqual(80);
        expect(capped.split("[").length).toBe(capped.split("]").length);
      }
    }
  });

  it("an ordinary long summary, description and result are cut as before (159 characters and an ellipsis; max characters and a count)", () => {
    for (const [harness, build] of ADAPTERS) {
      const long = "word ".repeat(120);
      const summary = prepareShare(build("summary", long), { mode: "full", config: CONFIG, harness, machine, knownSecrets: [] });
      expect(stepsOf(summary.session).flatMap((s) => (s.kind === "tool" ? [s.summary] : []))[0]).toHaveLength(SUMMARY_MAX);
      const description = prepareShare(build("description", long), { mode: "full", config: CONFIG, harness, machine, knownSecrets: [] });
      expect(stepsOf(description.session).flatMap((s) => (s.kind === "subagent" ? [s.description] : []))[0]).toHaveLength(SUMMARY_MAX);
      const result = prepareShare(build("result", `${"x ".repeat(499)}x`), { mode: "full", config: CONFIG, harness, machine, knownSecrets: [] });
      const step = stepsOf(result.session).find((s) => s.kind === "tool" && s.name.toLowerCase() === "bash")!;
      expect(step.kind === "tool" && step.result).toMatchObject({ truncatedFrom: 999 });
      expect(step.kind === "tool" && step.result?.text.startsWith(`${"x ".repeat(MAX / 2)}\n… [truncated 799 chars]`)).toBe(true);
    }
  });

  it("with the default maxToolChars (20000) a secret at the cut is still not published", () => {
    for (const [harness, build] of ADAPTERS) {
      for (const secret of planted()) {
        const prepared = prepareShare(build("result", `${"x ".repeat(9_990)}${lead(1)}${secret.value}`), {
          mode: "full",
          config: DEFAULT_CONFIG,
          harness,
          machine,
          knownSecrets: secret.known ? [knownSecret(secret.value, "DEMO_SERVICE_TOKEN", "env")] : [],
        });
        for (const text of Object.values(surfacesOf(prepared))) {
          expect(fragments(secret.value).filter((f) => text.includes(f)).length).toBe(0);
        }
        expect(prepared.report.blocked).toBe(false);
      }
    }
  });

  it("a secret wholly in the text that is cut off is reported but not published (the cost of redacting before cutting)", () => {
    const secret = fake.github();
    const prepared = prepareShare(claude("result", `${lead(MAX + 100)}${secret}`), { mode: "full", config: CONFIG, harness: "claude-code", machine, knownSecrets: [] });
    expect(prepared.report.counts["secret-pattern"]).toBeGreaterThanOrEqual(1);
    expect(fragments(secret).filter((f) => prepared.json.includes(f))).toHaveLength(0);
  });

  it("a file path summary (read/edit/write) is not cut, as before, and its home directory is still rewritten", () => {
    const prepared = prepareShare(new ClaudeTranscript(SESSION, CWD).user("go").assistant("m1", [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: `/home/tester/work/${"d/".repeat(100)}f.ts` } }], ccUsage(1, 1)).toolResult("t1", "ok").toJsonl(), { mode: "full", config: CONFIG, harness: "claude-code", machine, knownSecrets: [] });
    const summary = stepsOf(prepared.session).flatMap((s) => (s.kind === "tool" ? [s.summary] : []))[0]!;
    expect(summary.length).toBeGreaterThan(SUMMARY_MAX);
    expect(summary.endsWith("f.ts")).toBe(true);
    expect(summary.startsWith("~/work/")).toBe(true);
  });

  it("capToolText on a redacted session cuts nothing shorter than the cap and leaves the other fields alone", () => {
    const prepared = prepareShare(claude("result", "short"), { mode: "full", config: CONFIG, harness: "claude-code", machine, knownSecrets: [] });
    expect(capToolText(prepared.session, MAX)).toEqual(prepared.session);
  });

  // ── the adapters stay pure, the browse list still fits ──────────────────────────────────────────────────────────

  it("the adapters keep the text whole, so the cap lives in one place (after redaction)", () => {
    const long = `${"word ".repeat(100)}end`;
    for (const [harness, build] of ADAPTERS) {
      const parsed = parseSession(build("summary", long), harness).session;
      const tool = stepsOf(parsed).find((s) => s.kind === "tool");
      expect(tool?.kind === "tool" && tool.summary).toBe(long);
      const sub = parseSession(build("description", long), harness).session;
      const step = stepsOf(sub).find((s) => s.kind === "subagent");
      expect(step?.kind === "subagent" && step.description).toBe(long);
    }
  });

  it("the browse list labels still fit: a long summary or description is shown as the share will publish it", () => {
    for (const [harness, build] of ADAPTERS) {
      const long = `${"word ".repeat(300)}end`;
      for (const site of ["summary", "description"] as const) {
        const view = viewFromSession(parseSession(build(site, long), harness).session);
        const item = view.items.find((i) => i.kind === (site === "summary" ? "tool" : "subagent"))!;
        expect(item.label.length).toBeLessThanOrEqual(SUMMARY_MAX + 40); // the tool name or agent list in front, the text capped
        expect(item.label.endsWith("…")).toBe(true);
        expect(item.body.split("\n\n")[0]!.length).toBeLessThanOrEqual(2_000);
      }
    }
  });
});

/** The payload and every string the review exposes, as in tests/title-secret-prefix.vitest.ts. */
function surfaceTexts(prepared: ReturnType<typeof prepareShare>): Record<string, string> {
  return surfacesOf(prepared);
}
