import { describe, expect, it } from "vitest";
import { shannonEntropy } from "../src/redact/entropy.js";

/**
 * The values `@sanity-labs/secret-scan`'s `shannonEntropy` returned for these strings, before overshare wrote its own:
 * every entropy threshold in src/redact was set against that definition, so they must not move.
 */
const BEFORE: [string, number][] = [
  ["", 0],
  ["a", 0],
  ["aaaa", 0],
  ["ab", 1],
  ["aab", 0.9182958340544896],
  ["abcd", 2],
  ["hello world", 2.8453509366224368],
  ["0123456789abcdef", 4],
  // Counts code points but divides by UTF-16 length: three symbols over four units, not log2(3).
  ["a😀b", 1.5],
  ["é", 0],
];

describe("shannonEntropy", () => {
  it("gives the values the thresholds were set against", () => {
    for (const [s, h] of BEFORE) expect(shannonEntropy(s), JSON.stringify(s)).toBe(h);
  });
});
