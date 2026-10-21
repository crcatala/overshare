/**
 * Shapes of secret the pattern layer used to miss, and what fast-check found around them:
 *   - a credential assignment or auth header inside JSON that is itself held in a JSON string (`{\"password\":\"…\"}`),
 *     as in a log line or an API response a tool printed;
 *   - a JWT wrapped over lines, each piece too short for the `jwt` rule, on one line before `,` `.` `)` or `&`, or with a
 *     short payload or pretty-printed JSON;
 *   - a private key cut before its END line (`head id_rsa`, a truncated tool result).
 * Only fakes, assembled at runtime.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.js";
import { prepareShare } from "../src/pipeline.js";
import { Redactor } from "../src/redact/index.js";
import { findSecretPatterns } from "../src/redact/patterns.js";
import { rescanPayload } from "../src/redact/rescan.js";
import { ClaudeTranscript, ccUsage, fake, randomish } from "./helpers.js";

const machine = { homeDir: "/home/tester", username: "tester" };
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** `levels` rounds of JSON string encoding, without the outer quotes: text as it sits inside a string of that depth. */
const nested = (value: unknown, levels: number): string => {
  let text = JSON.stringify(value);
  for (let i = 0; i < levels; i++) text = JSON.stringify(text).slice(1, -1);
  return text;
};

/** A JWT header or payload: `value` as JSON, pretty-printed when `indent` is given, in base64url. */
const part = (value: unknown, indent?: number) => Buffer.from(JSON.stringify(value, null, indent)).toString("base64url");
const signature = (seed: number) => randomish(43, seed, `${B64.slice(0, 62)}-_`);
const jwt = (seed = 5): string =>
  `${part({ alg: "HS256", typ: "JWT" })}.${part({ sub: `user-${randomish(8, seed)}`, exp: 1900000000 })}.${signature(seed + 1)}`;

/** The token cut into lines of `width`, each continuation indented, as a terminal or a log prints it. */
const wrap = (token: string, width: number, indent = "  "): string[] => {
  const lines: string[] = [];
  for (let i = 0; i < token.length; i += width) lines.push(token.slice(i, i + width));
  return lines.map((l, i) => (i === 0 ? l : indent + l));
};

const pemLines = (n: number, seed = 41): string[] => Array.from({ length: n }, (_, i) => randomish(64, seed + i, B64));
const pemHeader = () => ["-----BEGIN ", "PRIVATE KEY-----"].join("");

describe("placeholders", () => {
  it("a bare `[REDACTED` in the transcript hides nothing after it (found by fast-check)", () => {
    const aws = fake.aws();
    const out = new Redactor(machine).redactText(`we print [REDACTED\nexport KEY_ID=${aws}\nwhen done]`, "test");
    expect(out).not.toContain(aws);
  });

  it("text inside one of our placeholders is still left alone", () => {
    expect(findSecretPatterns("[REDACTED:GITHUB_TOKEN] and [REDACTED:secret-assignment#2]")).toEqual([]);
  });
});

describe("escaped JSON", () => {
  it.each([1, 2])("redacts a password assigned in JSON held in %i level(s) of string", (levels) => {
    const value = `Pw${randomish(16, 3)}`;
    const r = new Redactor(machine);
    const out = r.redactText(`response: ${nested({ user: "app", password: value }, levels)}`, "test");
    expect(out).not.toContain(value);
    expect(out).toContain("[REDACTED:secret-assignment]");
    expect(rescanPayload(JSON.stringify({ text: out })).issues).toEqual([]);
  });

  it("keeps the escaped quotes around the value", () => {
    const value = `Pw${randomish(16, 3)}`;
    const out = new Redactor(machine).redactText(nested({ password: value }, 1), "test");
    expect(out).toBe('{\\"password\\":\\"[REDACTED:secret-assignment]\\"}');
  });

  it("redacts an auth header in escaped JSON", () => {
    const value = randomish(40, 9);
    const out = new Redactor(machine).redactText(nested({ headers: { Authorization: `Bearer ${value}` } }, 1), "test");
    expect(out).not.toContain(value);
  });

  it.each(["true", "False", "null", "none", "undefined", "string", "number"])(
    "redacts a value that only starts with the keyword %s (found by fast-check)",
    (word) => {
      const value = `${word}${randomish(10, 21)}7`;
      expect(new Redactor(machine).redactText(`{"password":"${value}"}`, "test")).not.toContain(value);
    },
  );

  it.each(["true", "null", "undefined"])("still treats the bare keyword %s as a placeholder", (word) => {
    expect(findSecretPatterns(`password = "${word}"`)).toEqual([]);
  });

  it.each([0, 1])("redacts a password ending in a backslash, in JSON held in %i level(s) of string", (levels) => {
    const value = `Pw7${randomish(14, 3)}\\`;
    const out = new Redactor(machine).redactText(nested({ password: value }, levels), "test");
    expect(out).toContain("[REDACTED:secret-assignment]");
    expect(out).not.toContain(value.slice(0, -1));
  });

  it("still takes an unquoted value with a backslash whole", () => {
    const value = `ab\\${randomish(12, 4)}`;
    const [m] = findSecretPatterns(`password=${value} next`);
    expect(m).toMatchObject({ rule: "secret-assignment" });
  });
});

describe("JWT", () => {
  it.each([20, 40, 64])("redacts a JWT wrapped at %i columns, leaving the next line", (width) => {
    const token = jwt(width);
    const lines = wrap(token, width);
    const r = new Redactor(machine);
    const out = r.redactText(`Bearer token:\n${lines.join("\n")}\nNext line of prose`, "test");
    expect(out).toContain("[REDACTED:jwt]");
    for (const line of lines) expect(out).not.toContain(line.trim());
    expect(out.endsWith("\nNext line of prose")).toBe(true);
    expect(rescanPayload(JSON.stringify({ text: out })).issues).toEqual([]);
  });

  it("redacts one wrapped between the `e` and `y` of its payload", () => {
    const token = jwt(7);
    const dot = token.indexOf(".");
    const out = new Redactor(machine).redactText(`${token.slice(0, dot + 2)}\n${token.slice(dot + 2)}`, "test");
    expect(out).toBe("[REDACTED:jwt]");
  });

  it("redacts one glued to the end of another token (found by fast-check)", () => {
    const token = jwt(3);
    const out = new Redactor(machine).redactText(`${fake.age()}${wrap(token, 12).join("\n")}`, "test");
    expect(out).toBe("[REDACTED:age-secret-key][REDACTED:jwt]");
  });

  it.each([
    ["near the start of the signature", 4, '";'],
    ["further into the signature", 20, '",'],
    ["in the payload", -1, '"'],
  ])("redacts a quoted one wrapped %s", (_where, intoSignature, close) => {
    const token = jwt(11);
    const cut = intoSignature < 0 ? token.indexOf(".") + 10 : token.lastIndexOf(".") + 1 + intoSignature;
    const out = new Redactor(machine).redactText(`token = "${token.slice(0, cut)}\n  ${token.slice(cut)}${close}\nnext line`, "test");
    expect(out).toBe(`token = "[REDACTED:jwt]${close}\nnext line`);
  });

  it("redacts one under a stray `ey` line (found by fast-check)", () => {
    const token = jwt(13);
    const out = new Redactor(machine).redactText(`ey\n${wrap(token, 36).join("\n")}\nnext line`, "test");
    expect(out).toBe("ey\n[REDACTED:jwt]\nnext line");
  });

  it("redacts one with a separator line under it (found by fast-check)", () => {
    const token = jwt(17);
    const out = new Redactor(machine).redactText(`${wrap(token, 36, "").join("\n")}\n----------\nnext line`, "test");
    expect(out).toBe("[REDACTED:jwt]\n----------\nnext line");
  });

  // Betterleaks' `jwt` rule ends at whitespace, a quote or `;`.
  it.each([
    ["a comma", (t: string) => `tokens: ${t}, then more`],
    ["a full stop", (t: string) => `The token is ${t}.`],
    ["a parenthesis", (t: string) => `verify(${t})`],
    ["an ampersand", (t: string) => `https://app.example.test/cb?v=${t}&state=1`],
  ])("redacts one on a single line before %s", (_before, place) => {
    const token = jwt(23);
    const out = new Redactor(machine).redactText(place(token), "test");
    expect(out).toBe(place("[REDACTED:jwt]"));
  });

  // Betterleaks' `jwt` rule wants 17 characters after each part's `ey`, and `{` then a line break encodes to `ew`.
  const SHAPES: Array<[string, string]> = [
    ["a short payload", `${part({ alg: "HS256", typ: "JWT" })}.${part({ sub: "1" })}.${signature(29)}`],
    ["only an algorithm in its header", `${part({ alg: "HS256" })}.${part({ uid: 12345 })}.${signature(31)}`],
    ["pretty-printed JSON", `${part({ alg: "HS256", typ: "JWT" }, 2)}.${part({ sub: "1234", iat: 1700000000 }, 2)}.${signature(37)}`],
    ["a pretty-printed header", `${part({ alg: "HS256", typ: "JWT" }, 2)}.${part({ sub: "1234", iat: 1700000000 })}.${signature(41)}`],
  ];

  describe.each(SHAPES)("with %s", (_shape, token) => {
    it.each([
      ["bare", (t: string) => `use ${t} now`],
      ["before a comma", (t: string) => `tokens: ${t}, then more`],
      ["in an auth header", (t: string) => `Authorization: Bearer ${t}`],
    ])("redacts one %s", (_where, place) => {
      expect(new Redactor(machine).redactText(place(token), "test")).toBe(place("[REDACTED:jwt]"));
    });

    it("redacts one wrapped over lines", () => {
      expect(new Redactor(machine).redactText(`${wrap(token, 24).join("\n")}\nnext line`, "test")).toBe("[REDACTED:jwt]\nnext line");
    });

    it("keeps it out of the share, which is not clean", () => {
      const raw = new ClaudeTranscript("aaaaaaaa-0000-0000-0000-000000000000", "/home/tester/work/demo")
        .user("log in to the test server")
        .assistant("m1", [{ type: "tool_use", id: "b1", name: "Bash", input: { command: "./login --print" } }], ccUsage(10, 5))
        .toolResult("b1", `issued ${token}, valid for 1h`)
        .toJsonl();
      const { json, report } = prepareShare(raw, { mode: "full", config: DEFAULT_CONFIG, machine, knownSecrets: [] });
      for (const piece of token.split(".")) expect(json).not.toContain(piece);
      expect(report.counts["secret-pattern"]).toBe(1);
      expect(report.clean).toBe(false);
      expect(report.blocked).toBe(false);
    });
  });

  it("leaves prose that only looks like one", () => {
    expect(findSecretPatterns("eyes looked up at the sky.\neyelids drooping over everything.\nsomething else here")).toEqual([]);
    expect(findSecretPatterns("see eyeglassesAndMoreThings.eyebrowsAndOtherThings.somethingElseHere, then")).toEqual([]);
    expect(findSecretPatterns("see ewesAndLambsInTheField.ewersOfWaterOnTheTable.somethingElseHere, then")).toEqual([]);
  });

  it("is high confidence: the re-scan blocks one left in the payload", () => {
    const wrapped = wrap(jwt(), 30).join("\n");
    expect(rescanPayload(JSON.stringify({ text: wrapped })).issues.map((i) => i.rule)).toContain("jwt");
  });
});

describe("truncated private key", () => {
  it("redacts the header and body lines of `head id_rsa`, leaving the prose after it", () => {
    const body = pemLines(3);
    const r = new Redactor(machine);
    const out = r.redactText(`$ head -4 id_rsa\n${pemHeader()}\n${body.join("\n")}\nthat was the key`, "test");
    for (const line of body) expect(out).not.toContain(line);
    expect(out).toBe("$ head -4 id_rsa\n[REDACTED:private-key-truncated]\nthat was the key");
  });

  it("redacts one with escaped line breaks", () => {
    const body = pemLines(2);
    const out = new Redactor(machine).redactText(nested({ key: `${pemHeader()}\n${body.join("\n")}` }, 0), "test");
    for (const line of body) expect(out).not.toContain(line);
  });

  it("redacts a last line cut short with text after it (found by fast-check)", () => {
    const body = pemLines(2);
    const cut = randomish(30, 77, B64);
    const out = new Redactor(machine).redactText(`${pemHeader()}\n${body.join("\n")}\n${cut}… [output truncated]`, "test");
    expect(out).not.toContain(cut);
    expect(out).toBe("[REDACTED:private-key-truncated]… [output truncated]");
  });

  // A generic rule of secret-scan, since removed (keyword `tru`, as in "truncated"), once won an overlap against the
  // key's rule and was then dropped as not random-looking, losing the key with it (found by fast-check).
  it("redacts a key after a `[truncated]` marker, with a path glued to it", () => {
    const aws = fake.aws();
    const r = new Redactor(machine);
    const out = r.redactText(`[truncated]\n${aws}/home/tester/x`, "test");
    expect(out).not.toContain(aws);
    expect(out).toContain("[REDACTED:aws-access-token]");
  });

  it("redacts both a key and a JWT its last line runs into (found by fast-check)", () => {
    // The key's long last line takes the JWT's header; the JWT's match takes that line too. Keeping only the longer
    // match (here the key's) used to leave the JWT's payload and signature, which no rule recognises without a header.
    const body = pemLines(3);
    const token = jwt(19);
    const lines = wrap(token, 37, "");
    const out = new Redactor(machine).redactText(`${pemHeader()}\n${body.join("\n")}\n${lines.join("\n")}\nnext line`, "test");
    for (const piece of [...body, ...token.split(".")]) expect(out).not.toContain(piece);
    expect(out.endsWith("]\nnext line")).toBe(true);
  });

  it("leaves a header with no key under it", () => {
    expect(findSecretPatterns(`if (line === "${pemHeader()}") {\n  start\n}`)).toEqual([]);
  });

  it("reports a complete key whole, not as truncated", () => {
    const text = `key:\n${fake.pem()}\n`;
    const matches = findSecretPatterns(text);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.rule).not.toBe("private-key-truncated");
    expect(text.slice(matches[0]?.start, matches[0]?.end)).toBe(fake.pem());
  });

  it("is high confidence: the re-scan blocks one left in the payload", () => {
    const text = `${pemHeader()}\n${pemLines(2).join("\n")}`;
    expect(rescanPayload(JSON.stringify({ text })).issues.map((i) => i.rule)).toContain("private-key-truncated");
  });
});
