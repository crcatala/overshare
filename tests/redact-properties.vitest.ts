/**
 * Property-based tests (fast-check) for the redaction layers: invariants that must hold for any input, not only for
 * the hand-picked examples elsewhere. Credentials are generated from a seed with `randomish`, so a shrunk counterexample
 * is still a random-looking token rather than `aaaa…`, which `isObviouslyFake` rightly ignores.
 *
 * A failure prints the seed and the shrunk input; rerun it with `fc.assert(..., { seed, path })`. Each property runs 100
 * cases; set `FC_NUM_RUNS` for a longer local search (`FC_NUM_RUNS=20000 npx vitest run tests/redact-properties.vitest.ts`).
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { Redactor } from "../src/redact/index.js";
import { findSecretPatterns, isPlaceholderValue } from "../src/redact/patterns.js";
import { rescanPayload } from "../src/redact/rescan.js";
import { randomish } from "./helpers.js";

fc.configureGlobal({ numRuns: Number(process.env.FC_NUM_RUNS) || 100 });

const machine = { homeDir: "/home/tester", username: "tester" };
const ALNUM = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const B64 = `${ALNUM}+/`;
const URL64 = `${ALNUM}-_`;

const seed = fc.integer({ min: 1, max: 0x7fffffff });

/** Prose lines of two or more words: a line holding a single bare word could be the tail of a wrapped token. */
const WORDS = ["the", "build", "passed", "after", "retry", "see", "logs", "for", "details", "deploy", "ok", "next", "step", "café", "日本語", "→", "λ"];
const proseLine = fc.array(fc.constantFrom(...WORDS), { minLength: 2, maxLength: 8 }).map((w) => w.join(" "));
const prose = fc.array(proseLine, { minLength: 1, maxLength: 3 }).map((l) => l.join("\n"));

const b64url = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
const jwtOf = (s: number) => `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url({ sub: randomish(10, s), iat: s })}.${randomish(43, s + 1, URL64)}`;

const wrapAt = (token: string, width: number, indent: string, eol: string): string => {
  const lines: string[] = [];
  for (let i = 0; i < token.length; i += width) lines.push(token.slice(i, i + width));
  return lines.map((l, i) => (i === 0 ? l : indent + l)).join(eol);
};

/** A credential as it would sit in text, with the pieces of it that must not survive redaction. */
interface Planted {
  text: string;
  pieces: string[];
}

const flat = (token: string): Planted => ({ text: token, pieces: [token] });
const pemHeader = ["-----BEGIN ", "PRIVATE KEY-----"].join("");

const planted: fc.Arbitrary<Planted> = fc.oneof(
  seed.map((s) => flat(["gh", "p_", randomish(36, s)].join(""))),
  seed.map((s) => flat(["sk", "-ant-", "api03-", randomish(93, s, URL64), "AA"].join(""))),
  seed.map((s) => flat(["AK", "IA", randomish(16, s, "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567")].join(""))),
  seed.map((s) => flat(["AGE-SECRET-KEY-", "1", randomish(58, s, "QPZRY9X8GF2TVDW0S3JN54KHCE6MUA7L")].join(""))),
  fc.record({ s: seed, width: fc.integer({ min: 8, max: 80 }), indent: fc.constantFrom("", "  ", "\t"), eol: fc.constantFrom("\n", "\r\n") }).map(({ s, width, indent, eol }) => {
    const token = jwtOf(s);
    return { text: wrapAt(token, width, indent, eol), pieces: token.split(".") };
  }),
  fc.record({ s: seed, lines: fc.integer({ min: 1, max: 8 }), last: fc.integer({ min: 4, max: 64 }), eol: fc.constantFrom("\n", "\r\n") }).map(({ s, lines, last, eol }) => {
    const body = Array.from({ length: lines }, (_, i) => randomish(i === lines - 1 ? last : 64, s + i, B64)).filter((l, i) => i < lines - 1 || l.length >= 4);
    if (body.join("").length < 64) body.push(randomish(64, s + 99, B64));
    return { text: [pemHeader, ...body].join(eol), pieces: body.filter((l) => l.length >= 16) };
  }),
);

const fragment = fc.oneof(
  fc.string({ unit: "grapheme", maxLength: 20 }),
  fc.constantFrom(" ", "\n", "\r\n", '"', "'", "\\", "\\\"", ".", "=", ":", "password=", "Authorization: Bearer ", "ey", "-----", pemHeader, "[REDACTED", "/home/tester/", "a@b.io"),
);
/** Arbitrary strings and the characters and fragments the rules care about, with no credential in them. */
const noise = fc.array(fragment, { maxLength: 12 }).map((parts) => parts.join(""));
/** The same, with credentials mixed in and glued to whatever is next to them. */
const spicy = fc.array(fc.oneof(fragment, planted.map((p) => p.text)), { maxLength: 12 }).map((parts) => parts.join(""));

describe("redaction properties", () => {
  it("pattern matches are ordered, disjoint and inside the text, for any text", () => {
    fc.assert(
      fc.property(spicy, (text) => {
        const matches = findSecretPatterns(text);
        let end = 0;
        for (const m of matches) {
          expect(m.start).toBeGreaterThanOrEqual(end);
          expect(m.end).toBeGreaterThan(m.start);
          expect(m.end).toBeLessThanOrEqual(text.length);
          end = m.end;
        }
      }),
    );
  });

  // The secret layer only: the path and email rules run after it and can make a token stand alone (`…sf/home/tester`
  // becomes `…sf~`), which the final re-scan then judges; the next property holds the full redaction to that.
  it("redacting redacted text finds no further secret", () => {
    const secretsOnly = { redactEmails: false, redactUsername: false };
    fc.assert(
      fc.property(spicy, (text) => {
        const once = new Redactor(secretsOnly).redactText(text, "test");
        expect(new Redactor(secretsOnly).redactText(once, "test")).toBe(once);
      }),
    );
  });

  // The guarantee is about publishing, not about the redactor alone: a credential is removed, or the final re-scan stops
  // the share. The re-scan blocking is a designed outcome, not a failure (a generic rule of the scanner can shadow a
  // trusted match until the path rule changes the text around it; see redaction-gaps.vitest.ts).
  it("no planted credential is published silently", () => {
    // Credentials on their own lines, between noise: two tokens glued into one run of token characters are not a case
    // the rules aim at (their boundary checks refuse a match inside a longer token, by design).
    const separated = planted.map((p) => ({ text: `\n${p.text}\n`, pieces: p.pieces }));
    const filler = noise.map((text) => ({ text, pieces: [] as string[] }));
    fc.assert(
      fc.property(fc.array(fc.oneof(filler, separated), { minLength: 1, maxLength: 8 }), (parts) => {
        const r = new Redactor(machine);
        const out = r.redactText(parts.map((p) => p.text).join(""), "test");
        if (!parts.some((p) => p.pieces.some((piece) => out.includes(piece)))) return;
        const { issues, suspicious } = rescanPayload(JSON.stringify({ text: out }), { homeDir: machine.homeDir, matchedSecrets: r.matchedSecrets() });
        expect(issues.length + suspicious.length).toBeGreaterThan(0);
      }),
    );
  });

  it("a planted credential is removed and the text around it kept", () => {
    fc.assert(
      fc.property(prose, planted, prose, (before, secret, after) => {
        const out = new Redactor(machine).redactText(`${before}\n${secret.text}\n${after}`, "test");
        for (const piece of secret.pieces) expect(out).not.toContain(piece);
        expect(out.startsWith(`${before}\n`)).toBe(true);
        expect(out.endsWith(`\n${after}`)).toBe(true);
        expect(rescanPayload(JSON.stringify({ text: out })).issues).toEqual([]);
      }),
    );
  });

  it("JSON string escaping does not hide a credential assignment", () => {
    const key = fc.constantFrom("password", "db_password", "apiKey", "api_key", "client_secret", "accessToken", "secret");
    // Not one the rule leaves alone on purpose (`test…`, `example…`, `your_…`): only the escaping is under test.
    const value = fc
      .record({ s: seed, n: fc.integer({ min: 10, max: 40 }) })
      .map(({ s, n }) => `${randomish(n, s)}${s % 10}x`)
      .filter((v) => !isPlaceholderValue(v));
    fc.assert(
      fc.property(key, value, fc.integer({ min: 0, max: 3 }), fc.boolean(), (k, v, levels, pretty) => {
        let text = JSON.stringify({ [k]: v }, null, pretty ? 2 : undefined);
        for (let i = 0; i < levels; i++) text = JSON.stringify(text).slice(1, -1);
        expect(new Redactor(machine).redactText(`got ${text} back`, "test")).not.toContain(v);
      }),
    );
  });
});
