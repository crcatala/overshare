/**
 * Betterleaks' rules were written for Go's regex engine, which runs in linear time. JavaScript's backtracks, and a
 * transcript is untrusted input, so each enabled rule is run here on long adversarial strings built from its own
 * keywords and character classes (keywords repeated, near-miss bodies, long runs of a class), under a time budget per
 * string. A linear rule takes a few milliseconds on the largest string; one that backtracks badly takes seconds (the
 * two found this way are written out by the converter or excluded, see `betterleaks-enabled.json`).
 *
 * A regex that backtracks exponentially does not fail this test, it hangs it: a match cannot be interrupted. Set
 * `FC_NUM_RUNS` for a longer search (`FC_NUM_RUNS=20000 npx vitest run tests/betterleaks-backtracking.vitest.ts`).
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { RULES } from "../src/redact/betterleaks.js";
import { randomish } from "./helpers.js";

fc.configureGlobal({ numRuns: Number(process.env.FC_NUM_RUNS) || 100 });

/** The largest window `findSecretPatterns` hands a rule (a 32 KB chunk and its 8 KB overlap). */
const WINDOW = 32_768 + 8_192;
/**
 * Per full window. The slowest enabled rule takes under 50 ms there on this machine; the two that backtracked took
 * seconds at a tenth of the size. Shorter strings get a share of it, never under 20 ms (compiling a regex on its first
 * run takes a few).
 */
const BUDGET_MS = 250;
const budgetFor = (size: number) => Math.max(20, (BUDGET_MS * size) / WINDOW);

const ASCII = [..."\t\n\r", ...Array.from({ length: 0x7f - 0x20 }, (_, i) => String.fromCharCode(0x20 + i))];
const SEPARATORS = ["=", ":", " = ", '"', "'", "`", "\n", "\r\n", "\r", "\t", " ", "\\", "\\n", ".", "-", "_", ",", ";", "{", "}"];

/** The ASCII characters each character class of a rule matches (bracketed classes and `\d`, `\w`, `\s`). */
function classesOf(source: string, flags: string): string[] {
  const out = new Set<string>();
  const add = (cls: string) => {
    const re = new RegExp(cls, flags.replace(/[gd]/g, ""));
    const chars = ASCII.filter((c) => re.test(c)).join("");
    if (chars) out.add(chars);
  };
  for (let i = 0; i < source.length; i++) {
    if (source[i] === "\\") {
      if (/[wdsWDS]/.test(source[i + 1] ?? "")) add(source.slice(i, i + 2));
      i++;
    } else if (source[i] === "[") {
      let j = i + 1;
      if (source[j] === "^") j++;
      if (source[j] === "]") j++;
      for (; j < source.length && source[j] !== "]"; j++) if (source[j] === "\\") j++;
      add(source.slice(i, j + 1));
      i = j;
    }
  }
  return [...out];
}

/** A rule's keywords as the table has them (lowercase), in upper case, and as its regex spells them, if it does. */
function keywordsOf(rule: (typeof RULES)[number]): string[] {
  const out = new Set(rule.keywords.flatMap((k) => [k, k.toUpperCase()]));
  for (const k of rule.keywords) {
    const at = rule.re.source.toLowerCase().indexOf(k);
    if (at !== -1) out.add(rule.re.source.slice(at, at + k.length));
  }
  return [...out].filter((k) => !/[\\[\]()]/.test(k));
}

const fill = (unit: string, size: number) => unit.repeat(Math.ceil(size / unit.length)).slice(0, size);

/** The adversarial strings for one rule, each `size` characters long. */
function adversarial(rule: (typeof RULES)[number], size: number): [string, string][] {
  const out: [string, string][] = [];
  const classes = classesOf(rule.re.source, rule.re.flags);
  for (const k of keywordsOf(rule)) {
    out.push([`${k} repeated`, fill(k, size)], [`"${k} = " repeated`, fill(`${k} = `, size)], [`"${k}\\r\\n" repeated`, fill(`${k}\r\n`, size)]);
    for (const [n, chars] of classes.entries()) {
      out.push([`${k}= and a run of class ${n}`, `${k}=${randomish(size, n + 1, chars)}`.slice(0, size)]);
      out.push([`${k}= and 40 of class ${n}, repeated`, fill(`${k}=${randomish(40, n + 3, chars)}\u0001`, size)]);
      out.push([`${k} and 200 of class ${n}, repeated`, fill(`${k}${randomish(200, n + 5, chars)}`, size)]);
    }
  }
  return out;
}

function timeMatches(re: RegExp, text: string): number {
  const start = performance.now();
  for (const _ of text.matchAll(re));
  return performance.now() - start;
}

describe("Betterleaks rules on adversarial input", () => {
  it("every enabled rule stays within the budget on a full window of each adversarial string", { timeout: 300_000 }, () => {
    const slow = new Map<string, string>();
    // Short strings first: a rule that backtracks takes milliseconds there and fails before a longer one runs, where it
    // could take minutes (curl-auth-header took 50 ms on 2 KB and seconds on 4 KB).
    for (const size of [2_048, 4_096, WINDOW]) {
      for (const rule of RULES.filter((r) => !slow.has(r.id))) {
        for (const [what, text] of adversarial(rule, size)) {
          const ms = timeMatches(rule.re, text);
          if (ms <= budgetFor(size)) continue;
          slow.set(rule.id, `${Math.round(ms)} ms on ${size} characters of ${what}`);
          break;
        }
      }
    }
    expect(Object.fromEntries(slow)).toEqual({});
  });

  it("no enabled rule backtracks badly on strings built from its own keywords and classes", { timeout: 300_000 }, () => {
    const rule = fc.integer({ min: 0, max: RULES.length - 1 }).map((i) => RULES[i]!);
    const input = rule.chain((r) => {
      const keywords = keywordsOf(r);
      const classes = classesOf(r.re.source, r.re.flags);
      const piece = fc.oneof(
        fc.constantFrom(...keywords),
        fc.constantFrom(...SEPARATORS),
        fc.record({ chars: fc.constantFrom(...(classes.length ? classes : ["a"])), n: fc.integer({ min: 1, max: 2_000 }), s: fc.integer() }).map(({ chars, n, s }) => randomish(n, s, chars)),
      );
      // A short unit repeated to a long string: what makes a regex that retries every start position pay for it.
      return fc.record({ rule: fc.constant(r), unit: fc.array(piece, { minLength: 1, maxLength: 8 }).map((p) => p.join("")), size: fc.integer({ min: 1_024, max: 16_384 }) });
    });
    fc.assert(
      fc.property(input, ({ rule: r, unit, size }) => {
        const ms = timeMatches(r.re, fill(unit, size));
        expect(ms, `${r.id} took ${Math.round(ms)} ms`).toBeLessThan(budgetFor(size));
      }),
    );
  });
});
