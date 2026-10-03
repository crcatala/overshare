/**
 * ass-ahh1: with no recorded title, the title is the first line of the first prompt cut at 80 characters. A secret
 * that straddles the cut used to be truncated before redaction, so the half that remained matched no pattern and no
 * known value, the final re-scan did not flag it either, and a long prefix of it was published in `session.title`.
 * Only planted fakes; the assertions look at the real pipeline's payload and at every string the CLI report and the
 * browse review expose.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { summarizeShare } from "../src/browse/job.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { capTitle, prepareShare } from "../src/pipeline.js";
import { knownSecret } from "../src/redact/known-values.js";
import { formatReport } from "../src/report.js";
import { PI_INPUT_PROVENANCE_TYPE, type HarnessName, type ShareMode } from "../src/schema.js";
import { ClaudeTranscript, PiTranscript, ccUsage, fake, piUsage } from "./helpers.js";

const machine = { homeDir: "/home/tester", username: "tester", hostname: "box" };
const MODES: ShareMode[] = ["full", "brief", "minimal", "prompts"];
/** The title is cut at 80 characters (79 + an ellipsis): 40 and 60 are well inside, 75 leaves a few, 79 and 80 leave none. */
const STARTS = [40, 60, 75, 79, 80];
const WINDOW = 8;

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

/** `lead` characters of ordinary words, ending in a space, so the secret starts at exactly that index. */
const lead = (n: number): string => `${"please deploy the app and ".repeat(5).slice(0, n - 1)} `;

/** The parts of a secret that must never appear: every window of it, but not a PEM's public header and footer lines. */
function fragments(secret: string): string[] {
  const body = secret.includes("\n") ? secret.split("\n").slice(1, -1).join("\n") : secret;
  const out: string[] = [];
  for (let i = 0; i + WINDOW <= body.length; i++) out.push(body.slice(i, i + WINDOW));
  return out;
}

const claude = (prompt: string) =>
  new ClaudeTranscript("aaaaaaaa-0000-0000-0000-000000000000", "/home/tester/work/demo")
    .user(prompt)
    .assistant("m1", [{ type: "text", text: "on it" }], ccUsage(1, 1))
    .toJsonl();
/** The prompt carries authored-input provenance, so prompts mode is available for pi too. */
function pi(prompt: string): string {
  const t = new PiTranscript();
  const timestamp = 1_700_000_000_000;
  const hash = createHash("sha256").update(prompt).digest("hex");
  t.entry("custom", { customType: PI_INPUT_PROVENANCE_TYPE, data: { version: 1, text: prompt, source: "interactive", messageTimestamp: timestamp, messageHash: hash } });
  t.entry("message", { message: { role: "user", content: [{ type: "text", text: prompt }], timestamp } });
  return t.assistant([{ type: "text", text: "on it" }], piUsage(1, 1)).toJsonl();
}
const ADAPTERS: Array<[HarnessName, (prompt: string) => string]> = [
  ["claude-code", claude],
  ["pi", pi],
];

describe("a secret that straddles the title cut", () => {
  for (const [harness, build] of ADAPTERS) {
    for (const mode of MODES) {
      for (const start of STARTS) {
        it.each(planted())(`$name at char ${start}: not in the payload or any report string (${harness}, ${mode})`, (secret) => {
          const prompt = `${lead(start)}${secret.value}\nand then run the tests`;
          const prepared = prepareShare(build(prompt), {
            mode,
            config: DEFAULT_CONFIG,
            harness,
            machine,
            knownSecrets: secret.known ? [knownSecret(secret.value, "DEMO_SERVICE_TOKEN", "env")] : [],
          });
          const surfaces = {
            payload: prepared.json,
            title: prepared.session.title ?? "",
            human: formatReport(prepared.report, { maxFindings: Infinity }),
            json: JSON.stringify(prepared.report),
            browse: JSON.stringify(summarizeShare(prepared)),
          };
          for (const [surface, text] of Object.entries(surfaces)) {
            const leaked = fragments(secret.value).filter((f) => text.includes(f));
            // Counts only: the number of leaked windows, never which.
            expect({ surface, leakedWindows: leaked.length }).toEqual({ surface, leakedWindows: 0 });
          }
          expect(prepared.report.blocked).toBe(false);
          // The title is still there, still the first line of the prompt, and still at most 80 characters.
          expect(prepared.session.title).toBeTruthy();
          expect(prepared.session.title!.length).toBeLessThanOrEqual(80);
          expect(prepared.session.title!.startsWith("please deploy")).toBe(true);
        });
      }
    }
  }

  it("is replaced by its marker, not cut mid-token, when it ends inside the title", () => {
    const secret = fake.github();
    const prepared = prepareShare(claude(`${lead(40)}${secret}\nmore`), { mode: "brief", config: DEFAULT_CONFIG, machine, knownSecrets: [] });
    expect(prepared.session.title).toMatch(/\[REDACTED:[\w-]+\]$/);
  });

  // The marker that replaces a secret is longer than most prompts' tail, so a secret starting near the end of the title
  // leaves a marker that spans the 79-character cut: it must be dropped whole, never cut to `[REDACTED:gith…`.
  it.each([65, 70, 75, 78])("a marker that spans the cut is dropped whole (secret at char %i)", (start) => {
    const prepared = prepareShare(claude(`${lead(start)}${fake.github()}\nmore`), { mode: "brief", config: DEFAULT_CONFIG, machine, knownSecrets: [] });
    const title = prepared.session.title!;
    expect(title.length).toBeLessThanOrEqual(start);
    expect(title.endsWith("…")).toBe(true);
    expect(title).not.toContain("[");
    expect(title).not.toContain("REDACTED");
  });

  it("a marker that ends exactly at the cut is kept whole", () => {
    const marker = "[REDACTED:github-v2]";
    const title = capTitle(`${"a".repeat(79 - marker.length)}${marker}tail beyond the cut`);
    expect(title).toBe(`${"a".repeat(79 - marker.length)}${marker}…`);
  });

  it("capTitle never splits a token, whatever its length or kind, at any cut position", () => {
    for (const marker of ["[REDACTED:private-key-block]", "[REDACTED]", "[email]", "[user]", "[host]"]) {
      for (let start = 50; start <= 80; start++) {
        const title = capTitle(`${"a".repeat(start)}${marker}${"b".repeat(40)}`);
        expect(title.length).toBeLessThanOrEqual(80);
        expect(title.split("[").length).toBe(title.split("]").length); // every opened token is closed
      }
    }
  });

  it("is still found as one finding in the prompt (the title does not hide or double-report it in the review)", () => {
    const secret = fake.anthropic();
    const prepared = prepareShare(claude(`${lead(60)}${secret}`), { mode: "full", config: DEFAULT_CONFIG, machine, knownSecrets: [] });
    expect(prepared.report.counts["secret-pattern"]).toBeGreaterThanOrEqual(1);
    expect(prepared.report.findings.some((f) => f.where === "title")).toBe(true);
    expect(prepared.report.findings.some((f) => f.where.endsWith("prompt"))).toBe(true);
  });

  it("an ordinary long title is still cut at 79 characters plus an ellipsis", () => {
    const prepared = prepareShare(claude("word ".repeat(40)), { mode: "brief", config: DEFAULT_CONFIG, machine, knownSecrets: [] });
    expect(prepared.session.title).toHaveLength(80);
    expect(prepared.session.title!.endsWith("…")).toBe(true);
  });
});
