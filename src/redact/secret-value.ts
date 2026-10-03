import { inspect } from "node:util";
import { shannonEntropy } from "@sanity-labs/secret-scan";

const MASK = "[redacted]";

/**
 * When a long prefix or suffix of a secret counts as a leak of it (the backstop for a secret cut in two before
 * redaction, ass-ahh1). A fragment of ordinary text shared with the start or end of a value (`postgres://user:`,
 * a host name, a path, a JWT header) must not count, so every bound is a filter: the value is long enough, the
 * fragment is a good part of it, and it holds one long run of characters that looks random.
 */
export interface FragmentPolicy {
  /** Values shorter than this are not checked. */
  minValueLength: number;
  /** The fragment is this fraction of the value, rounded up, within `minFragment` and `maxFragment`. */
  ratio: number;
  minFragment: number;
  maxFragment: number;
  /** The fragment's longest run of token characters (`A-Za-z0-9+/_=-`; a scheme, host or path separator ends one) must be this long... */
  minRun: number;
  /** ...reach this Shannon entropy per character... */
  minEntropy: number;
  /** ...and be less than this fraction lowercase words of 4+ letters (identifiers and host names are, random tokens rarely are). */
  maxWordRatio: number;
}

export type FragmentEnd = "prefix" | "suffix";

/**
 * A secret string that cannot be printed or serialized by accident. The text lives in a `#private`
 * field, so `JSON.stringify`, `Object.keys`, spreading, `structuredClone` and `util.inspect` never see it,
 * and every string conversion yields `[redacted]`. There is deliberately no getter: the matchers the
 * redaction layers need (`isIn`, `countIn`, `replaceIn`, `contains`, `inSet`, `equals`) live here, so no
 * code outside this file ever holds the raw value. `tests/secret-value.vitest.ts` enforces that.
 */
export class SecretValue {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  /** Length is already reported (`rescan` issues), so it is not secret. */
  get length(): number {
    return this.#value.length;
  }

  /** The secret occurs in `text`. */
  isIn(text: string): boolean {
    return text.includes(this.#value);
  }

  /** Number of non-overlapping occurrences of the secret in `text`. */
  countIn(text: string): number {
    return text.split(this.#value).length - 1;
  }

  /** `text` with every occurrence of the secret replaced. */
  replaceIn(text: string, replacement: string): string {
    return text.split(this.#value).join(replacement);
  }

  /** `fragment` is part of the secret (used to keep secret-derived labels out of tokens). */
  contains(fragment: string): boolean {
    return this.#value.includes(fragment);
  }

  /** The secret is one of `values` (the allowlist). */
  inSet(values: ReadonlySet<string>): boolean {
    return values.has(this.#value);
  }

  equals(other: string): boolean {
    return this.#value === other;
  }

  /** Length of the fragment `hasFragmentIn` looks for under `policy`; 0 when the value is not checked. Not secret: derived from the length. */
  fragmentLength(policy: FragmentPolicy): number {
    if (this.#value.length < policy.minValueLength) return 0;
    const n = Math.min(policy.maxFragment, Math.max(policy.minFragment, Math.ceil(this.#value.length * policy.ratio)));
    return n < this.#value.length ? n : 0;
  }

  /**
   * The first or last `fragmentLength(policy)` characters of the secret occur in `text`, and that fragment looks
   * random enough to be part of a secret rather than shared ordinary text. Reports which end, never the fragment.
   */
  hasFragmentIn(text: string, policy: FragmentPolicy): FragmentEnd | undefined {
    const n = this.fragmentLength(policy);
    if (!n) return undefined;
    // Every HS256 JWT starts with the same header, which is ordinary text; the fragment starts after it.
    const start = JWT_HEADER.exec(this.#value)?.[0].length ?? 0;
    for (const [end, fragment] of [
      ["prefix", this.#value.slice(start, start + n)],
      ["suffix", this.#value.slice(-n)],
    ] as const) {
      if (looksRandom(fragment, policy) && text.includes(fragment)) return end;
    }
    return undefined;
  }

  toString(): string {
    return MASK;
  }

  toJSON(): string {
    return MASK;
  }

  [Symbol.toPrimitive](): string {
    return MASK;
  }

  [inspect.custom](): string {
    return MASK;
  }
}

const JWT_HEADER = /^eyJ[A-Za-z0-9_-]*\./;

function looksRandom(fragment: string, policy: FragmentPolicy): boolean {
  const run = (fragment.match(/[A-Za-z0-9+/_=-]+/g) ?? []).reduce((best, r) => (r.length > best.length ? r : best), "");
  if (run.length < policy.minRun) return false;
  const wordChars = (run.match(/[a-z]{4,}/g) ?? []).reduce((n, w) => n + w.length, 0);
  return wordChars / run.length < policy.maxWordRatio && shannonEntropy(run) >= policy.minEntropy;
}
