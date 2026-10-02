import { inspect } from "node:util";

const MASK = "[redacted]";

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
