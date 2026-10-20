import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { RULES, findBetterleaks, firstGroupHoldsAll, rulesFor } from "../src/redact/betterleaks.js";
import enabled from "../src/redact/betterleaks-enabled.json" with { type: "json" };
import table from "../src/redact/betterleaks-rules.json" with { type: "json" };
import { Redactor } from "../src/redact/index.js";
import { findSecretPatterns } from "../src/redact/patterns.js";
import { randomish } from "./helpers.js";

const ALNUM = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const LOWER_DIGITS = "abcdefghijklmnopqrstuvwxyz0123456789";
const HEX = "0123456789abcdef";
let seed = 101;
const body = (n: number, alphabet = ALNUM) => randomish(n, (seed += 7), alphabet);

const rulesOf = (text: string) => findBetterleaks(text).map((m) => m.rule);
const b64url = (json: object) => Buffer.from(JSON.stringify(json)).toString("base64url");
const uuid = () => [8, 4, 4, 4, 12].map((n) => body(n, LOWER_DIGITS)).join("-");

describe("the enabled list", () => {
  const high = table.rules.filter((r) => r.confidence === "high").map((r) => r.id);
  const excluded = Object.keys(enabled.excluded);

  it("lists every high-confidence rule once, as enabled or as excluded with a reason", () => {
    expect([...enabled.enabled, ...excluded].sort()).toEqual([...high].sort());
    for (const [id, reason] of Object.entries(enabled.excluded)) expect(reason.length, id).toBeGreaterThan(20);
  });

  it("enables only high-confidence rules, each compiled once", () => {
    expect(new Set(enabled.enabled).size).toBe(enabled.enabled.length);
    expect(RULES.map((r) => r.id)).toEqual(table.rules.filter((r) => enabled.enabled.includes(r.id)).map((r) => r.id));
    expect(table.rules.filter((r) => r.confidence !== "high" && enabled.enabled.includes(r.id))).toEqual([]);
  });

  it("finds nothing with an excluded rule", () => {
    expect(enabled.excluded).toHaveProperty(["posthog-project-api-key"]);
    expect(rulesOf(`posthog init ${["ph", "c_"].join("")}${body(43)}`)).toEqual([]);
  });
});

describe("keywords", () => {
  it("are lowercase ASCII of three or more characters, which the keyword index relies on", () => {
    for (const r of RULES) {
      expect(r.keywords.length, r.id).toBeGreaterThan(0);
      for (const k of r.keywords) expect(k, r.id).toMatch(/^[\x20-\x40\x5b-\x7e]{3,}$/);
    }
  });

  // The definition the index must agree with: a rule runs when the lowercased text includes one of its keywords.
  const reference = (text: string) => {
    const lower = text.toLowerCase();
    return RULES.flatMap((r, i) => (r.keywords.some((k) => lower.includes(k)) ? [i] : []));
  };
  const keyword = fc.constantFrom(...new Set(RULES.flatMap((r) => r.keywords)));
  const cased = fc.tuple(keyword, fc.integer()).map(([k, n]) => [...k].map((c, i) => ((n >> i) & 1 ? c.toUpperCase() : c)).join(""));

  it("select the same rules as testing each keyword in the lowercased text", () => {
    const text = fc.array(fc.oneof(cased, fc.string({ maxLength: 6 }), fc.constantFrom("_", "-", ".", " ", "K", "\u212a")), { maxLength: 12 }).map((p) => p.join(""));
    fc.assert(
      fc.property(text, (t) => {
        expect(rulesFor(t)).toEqual(reference(t));
      }),
    );
    expect(rulesFor("")).toEqual([]);
    expect(rulesFor("gh")).toEqual([]);
  });
});

describe("Betterleaks detection", () => {
  // Formats nothing else recognises: secret-scan has no rule for them and token-formats.ts no entry.
  it.each([
    ["aikido-ci-token", () => ["AIK_", "CI_", body(40)].join("")],
    ["mongodb-atlas-service-account-secret", () => ["mdb_sa", "_sk_", body(40, `${ALNUM}_-`)].join("")],
    ["devin-service-user-token", () => ["co", "g_", body(52, "abcdefghijklmnopqrstuvwxyz234567")].join("")],
    ["canva-client-secret", () => ["cnv", "ca", body(51, `${ALNUM}_-`)].join("")],
    ["zuplo-consumer-api-key.1", () => ["zpk", "a_", body(32, LOWER_DIGITS), "_", body(8, HEX)].join("")],
  ])("finds a bare %s at high confidence and names the placeholder after it", (rule, token) => {
    const value = token();
    expect(findSecretPatterns(`printed ${value} here`).map((m) => [m.rule, m.confidence])).toEqual([[rule, "high"]]);
    expect(new Redactor().redactText(`printed ${value} here`)).toBe(`printed [REDACTED:${rule}] here`);
  });

  it("wins a tie with secret-scan, so a GitHub token is [REDACTED:github-pat]", () => {
    const token = ["gh", "p_", body(36)].join("");
    expect(new Redactor().redactText(`token ${token}`)).toBe("token [REDACTED:github-pat]");
  });

  it("redacts the value group of a keyword rule, not the key or the quotes around it", () => {
    const secret = body(32);
    const text = `LARK_APP_SECRET="${secret}"\n`;
    const [m] = findBetterleaks(text);
    expect(m?.rule).toBe("lark-app-secret");
    expect(text.slice(m?.start, m?.end)).toBe(secret);
  });

  it("uses the rule's own value group where it names one, not the first group", () => {
    // sonar-api-token's first group is the key's `token`; its second is the value.
    const secret = `squ_${body(40, LOWER_DIGITS)}`;
    const text = `sonar_token = ${secret}\n`;
    const [m] = findBetterleaks(text).filter((f) => f.rule === "sonar-api-token");
    expect(text.slice(m?.start, m?.end)).toBe(secret);
  });

  // Their first group is one of the alternatives a base64-encoded JWT header starts with, and one UUID segment.
  it.each([
    ["jwt-base64", () => Buffer.from(`${b64url({ alg: "HS256", typ: "JWT" })}.${b64url({ sub: body(16) })}.${body(43)}`).toString("base64").replace(/=+$/, "")],
    ["microsoft-teams-webhook", () => `https://${body(8, LOWER_DIGITS)}.${["web", "hook"].join("")}.office.com/webhookb2/${uuid()}@${uuid()}/IncomingWebhook/${body(32, LOWER_DIGITS)}/${uuid()}`],
  ])("redacts the whole of a %s, whose first group is only a piece of it", (rule, token) => {
    const value = token();
    expect(new Redactor().redactText(`value: ${value}\n`)).toBe(`value: [REDACTED:${rule}]\n`);
  });

  it("redacts the whole match only where the first group does not hold the others", () => {
    const groups = (r: (typeof RULES)[number]) => new RegExp(`${r.re.source}|`).exec("")!.length - 1;
    expect(RULES.filter((r) => r.group === undefined && groups(r) > 0).map((r) => r.id)).toEqual(["jwt-base64", "microsoft-teams-webhook"]);
    expect(firstGroupHoldsAll("((a)(?<n>b))")).toBe(true);
    expect(firstGroupHoldsAll("(?:x)(a)[(]\\((?<=y)")).toBe(true);
    expect(firstGroupHoldsAll("(a)(b)")).toBe(false);
    expect(firstGroupHoldsAll("(?:(a)|(b))")).toBe(false);
    expect(firstGroupHoldsAll("abc")).toBe(false);
  });

  it("drops a match under the rule's entropy threshold", () => {
    // Not the obviously-fake check's kind of placeholder (no run, no sequence): three characters repeated, entropy 1.6.
    expect(rulesOf(`${["dd", "p_"].join("")}${"aB7".repeat(12)} `)).toEqual([]);
    expect(rulesOf(`${["dd", "p_"].join("")}${body(36)} `)).toEqual(["deno-account-token"]);
  });

  it("runs a rule whatever the case of its keyword in the text", () => {
    // azure-ad-client-secret's keywords are `0Q~` to `9Q~`, lowercased in the table; the text has them as written.
    const secret = `${body(3)}8Q~${body(34, `${ALNUM}_~.-`)}`;
    expect(rulesOf(`secret: "${secret}"`)).toContain("azure-ad-client-secret");
  });
});
