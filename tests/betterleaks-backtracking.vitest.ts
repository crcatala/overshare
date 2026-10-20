/**
 * Betterleaks' rules were written for Go's regex engine, which runs in linear time. JavaScript's backtracks, and a
 * transcript is untrusted input, so each enabled rule is run on long adversarial strings built from its own keywords
 * and character classes (keywords repeated, near-miss bodies, long runs of a class), under a time budget per string. A
 * linear rule takes a few milliseconds on the largest string; one that backtracks badly takes seconds (the ones found
 * this way are written out by the converter or excluded, see `betterleaks-enabled.json`).
 *
 * The timing runs in a child process (`betterleaks-adversarial.ts`), killed after a timeout: a regex that backtracks
 * exponentially never returns, and a match cannot be interrupted in the process running it. Set `FC_NUM_RUNS` for a
 * longer search (`FC_NUM_RUNS=20000 npx vitest run tests/betterleaks-backtracking.vitest.ts`).
 *
 * Strings built from keywords and classes don't reach every slow shape: a rule needs its prefix to match before a
 * later part of it can backtrack. The shape that took temporal-cloud-api-key.1 close to a minute is checked in the
 * regex instead.
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { RULES } from "../src/redact/betterleaks.js";
import table from "../src/redact/betterleaks-rules.json" with { type: "json" };
import { charsOf } from "./betterleaks-adversarial.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const NUM_RUNS = Number(process.env.FC_NUM_RUNS) || 100;

/** Runs a mode of `betterleaks-adversarial.ts` and returns its slow rules, or the rule it was on when it timed out. */
function runAdversarial(mode: "sweep" | "property", timeoutMs: number): Record<string, string> {
  const run = spawnSync(process.execPath, ["--import", "tsx", join(root, "tests", "betterleaks-adversarial.ts"), mode], {
    cwd: root,
    encoding: "utf8",
    timeout: timeoutMs,
    killSignal: "SIGKILL",
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, FC_NUM_RUNS: String(NUM_RUNS) },
  });
  const lines = run.stdout.trimEnd().split("\n");
  const last = lines.findLast((l) => l.startsWith("rule "))?.slice(5) ?? "(none started)";
  if (run.signal) return { [last]: `still running after ${timeoutMs / 1000} s, killed` };
  const slow = lines.find((l) => l.startsWith("slow "));
  if (run.status !== 0 || !slow) return { [last]: run.stderr.trim().split("\n").slice(-12).join("\n") };
  return JSON.parse(slow.slice(5)) as Record<string, string>;
}

/**
 * An unbounded run of a class, a literal the class also matches, and another unbounded run of a class that overlaps it
 * (`[A-Za-z0-9_-]*Y2NvdW50X2lk[A-Za-z0-9_-]*`): on a string repeating the literal, every split between the two runs is
 * tried, polynomial in its length. The runs are classes, `\w`-style escapes or `.`.
 */
const RUN = String.raw`(\[(?:\\.|[^\]\\])*\]|\\[wdsWDS]|\.)(?:\*|\+|\{\d+,\})\??`;
function overlappingRuns(source: string, flags: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(new RegExp(`${RUN}((?:[A-Za-z0-9_=]|\\\\.)*)(?=${RUN})`, "g"))) {
    const next = new RegExp(RUN).exec(source.slice(m.index + m[0].length))!;
    const [a, b] = [charsOf(m[1]!, flags), charsOf(next[1]!, flags)];
    const literal = m[2]!.replace(/\\(.)/g, "$1");
    if ([...literal].every((c) => a.includes(c) && b.includes(c)) && [...a].some((c) => b.includes(c))) out.push(`${m[0]}${next[0]}`);
  }
  return out;
}

describe("Betterleaks rules on adversarial input", () => {
  it("every enabled rule stays within the budget on a full window of each adversarial string", { timeout: 300_000 }, () => {
    expect(runAdversarial("sweep", 240_000)).toEqual({});
  });

  it("no enabled rule backtracks badly on strings built from its own keywords and classes", { timeout: 120_000 + NUM_RUNS * 110 }, () => {
    // A run takes at most 100 ms (16 KB at the budget) before it fails, so the timeout only ever stops a hang.
    expect(runAdversarial("property", 60_000 + NUM_RUNS * 100)).toEqual({});
  });

  it("no enabled rule has two overlapping unbounded runs around a literal they both match", () => {
    const found = RULES.flatMap((r) => overlappingRuns(r.re.source, r.re.flags).map((s) => `${r.id}: ${s}`));
    expect(found).toEqual([]);
    // The check finds the rule it was written for, which is excluded.
    const temporal = table.rules.find((r) => r.id === "temporal-cloud-api-key.1")!;
    expect(overlappingRuns(temporal.regex, temporal.flags)).toHaveLength(2);
  });
});
