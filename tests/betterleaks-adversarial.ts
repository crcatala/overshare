/**
 * The timing half of `betterleaks-backtracking.vitest.ts`, run in a child process: a regex that backtracks
 * exponentially cannot be interrupted in the process running it, so the test kills this one after a timeout instead of
 * hanging, and names the rule from the last `rule` line printed.
 *
 *   node --import tsx tests/betterleaks-adversarial.ts sweep       # every enabled rule on fixed adversarial strings
 *   node --import tsx tests/betterleaks-adversarial.ts property    # FC_NUM_RUNS random ones
 *
 * Prints `rule <id>` before timing a rule, then `slow <json>`: rule id → what was over budget.
 */
import fc from "fast-check";
import { pathToFileURL } from "node:url";
import { RULES } from "../src/redact/betterleaks.js";
import { randomish } from "./helpers.js";

/** The largest window `findSecretPatterns` hands a rule (a 32 KB chunk and its 8 KB overlap). */
export const WINDOW = 32_768 + 8_192;
/**
 * Per full window. The slowest enabled rule takes under 50 ms there on this machine; the two that backtracked took
 * seconds at a tenth of the size. Shorter strings get a share of it, never under 20 ms (compiling a regex on its first
 * run takes a few).
 */
const BUDGET_MS = 250;
export const budgetFor = (size: number) => Math.max(20, (BUDGET_MS * size) / WINDOW);

const ASCII = [..."\t\n\r", ...Array.from({ length: 0x7f - 0x20 }, (_, i) => String.fromCharCode(0x20 + i))];
const SEPARATORS = ["=", ":", " = ", '"', "'", "`", "\n", "\r\n", "\r", "\t", " ", "\\", "\\n", ".", "-", "_", ",", ";", "{", "}"];

/** The ASCII characters a character class matches (`[…]`, `\d`, `\w`, `\s`, `.`), under a rule's flags. */
export function charsOf(cls: string, flags: string): string {
  const re = new RegExp(`^${cls}$`, flags.replace(/[gd]/g, ""));
  return ASCII.filter((c) => re.test(c)).join("");
}

/** The ASCII characters each character class of a rule matches (bracketed classes and `\d`, `\w`, `\s`). */
function classesOf(source: string, flags: string): string[] {
  const out = new Set<string>();
  const add = (cls: string) => {
    const chars = charsOf(cls, flags);
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

const progress = (id: string) => process.stdout.write(`rule ${id}\n`);

/** Every enabled rule on each adversarial string: rule id → the first string it was over budget on. */
function sweep(): Record<string, string> {
  const slow = new Map<string, string>();
  // Short strings first: a rule that backtracks takes milliseconds there and fails before a longer one runs, where it
  // could take minutes (curl-auth-header took 50 ms on 2 KB and seconds on 4 KB).
  for (const size of [2_048, 4_096, WINDOW]) {
    for (const rule of RULES.filter((r) => !slow.has(r.id))) {
      progress(rule.id);
      for (const [what, text] of adversarial(rule, size)) {
        const ms = timeMatches(rule.re, text);
        if (ms <= budgetFor(size)) continue;
        slow.set(rule.id, `${Math.round(ms)} ms on ${size} characters of ${what}`);
        break;
      }
    }
  }
  return Object.fromEntries(slow);
}

/** Random strings built from a rule's keywords, separators and classes: the smallest one found over budget, if any. */
function property(): Record<string, string> {
  let slow: Record<string, string> = {};
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
  try {
    fc.assert(
      fc.property(input, ({ rule: r, unit, size }) => {
        progress(r.id);
        const ms = timeMatches(r.re, fill(unit, size));
        if (ms < budgetFor(size)) return;
        // Shrinking runs the property again on smaller inputs, so the last failure recorded is the smallest.
        slow = { [r.id]: `${Math.round(ms)} ms on ${size} characters of ${JSON.stringify(unit.slice(0, 60))} repeated` };
        throw new Error(slow[r.id]);
      }),
      { numRuns: Number(process.env.FC_NUM_RUNS) || 100 },
    );
  } catch (e) {
    if (!Object.keys(slow).length) throw e;
  }
  return slow;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const mode = process.argv[2];
  if (mode === "sweep") process.stdout.write(`slow ${JSON.stringify(sweep())}\n`);
  else if (mode === "property") process.stdout.write(`slow ${JSON.stringify(property())}\n`);
  else throw new Error(`unknown mode ${mode}`);
}
