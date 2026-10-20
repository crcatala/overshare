import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { convertFilter, convertRules, formatJson, parseToml, sha256, translateRegex, type Upstream } from "../scripts/update-betterleaks.ts";

const root = join(import.meta.dirname, "..");
const vendor = join(root, "vendor/betterleaks");
const committed = readFileSync(join(root, "src/redact/betterleaks-rules.json"), "utf8");
const table = JSON.parse(committed) as { rules: { id: string; regex: string; flags: string }[]; skipped: { id: string; reason: string }[] };
const upstream = JSON.parse(readFileSync(join(vendor, "upstream.json"), "utf8")) as Upstream;

/** Every match of a translated Go regex in `text`. */
function matches(go: string, text: string): string[] {
  const { source, flags } = translateRegex(go);
  return [...text.matchAll(new RegExp(source, `${flags}g`))].map((m) => m[0]);
}

describe("the committed rule table", () => {
  it("compiles every rule on this Node (CI runs 22 and 24)", () => {
    expect(table.rules.length).toBeGreaterThan(400);
    for (const r of table.rules) expect(() => new RegExp(r.regex, `${r.flags}g`), r.id).not.toThrow();
  });

  it("uses no inline modifier group, which Node 22 rejects", () => {
    for (const r of table.rules) expect(r.regex, r.id).not.toMatch(/\(\?[a-zA-Z]*-?[a-zA-Z]+[:)]/);
  });

  it("carries no validate, analyze or revoke step, nor any of Betterleaks' expression code", () => {
    for (const r of table.rules) for (const k of ["validate", "analyze", "revoke", "filter"]) expect(r, r.id).not.toHaveProperty(k);
    for (const word of ["validate", "analyze", "revoke", "http.", "finding["]) expect(committed).not.toContain(word);
  });

  it("is what converting the vendored file gives (update:betterleaks --check)", () => {
    const conversion = convertRules(parseToml(readFileSync(join(vendor, "betterleaks.toml"), "utf8")));
    expect(formatJson(upstream, conversion)).toBe(committed);
  });

  it("vendors the rule file unchanged, with its license and provenance", () => {
    expect(sha256(join(vendor, "betterleaks.toml"))).toBe(upstream.sha256);
    expect(upstream).toMatchObject({ repository: "https://github.com/betterleaks/betterleaks", file: "config/betterleaks.toml" });
    expect(upstream.tag).toMatch(/^v\d+\.\d+\.\d+$/);
    expect(upstream.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(readFileSync(join(vendor, "LICENSE"), "utf8")).toMatch(/^MIT License/);
  });
});

describe("translateRegex", () => {
  it("hoists a leading (?i) to the i flag and leaves the rest as written", () => {
    expect(translateRegex("(?i)abc[a-f0-9]{3}")).toEqual({ source: "abc[a-f0-9]{3}", flags: "i" });
  });

  it("gives multi-line ^ and $ Go's meaning, which breaks lines at \\n only", () => {
    expect(translateRegex("(?im)^key$")).toEqual({ source: "(?<![^\\n])key(?![^\\n])", flags: "i" });
    expect(matches("(?m)^ab$", "ab\r\nab\nab")).toEqual(["ab", "ab"]);
    expect(matches("(?m)^ab$", "x\u2028ab")).toEqual([]);
    expect(matches("(?m)[$^]", "a$^")).toEqual(["$", "^"]);
  });

  it("spells out a mid-pattern (?i) up to the end of its group, as Go scopes it", () => {
    const { source, flags } = translateRegex("ab-(?i)[a-c]x");
    expect(flags).toBe("");
    expect(source).toBe("ab-[a-cA-C][xX]");
    expect(matches("ab-(?i)[a-c]x", "ab-Cx ab-cX AB-cx")).toEqual(["ab-Cx", "ab-cX"]);
    // The flag lasts across `|` within the group and ends with it.
    expect(matches("(?:a(?i)b|c)d", "aBd Cd cD")).toEqual(["aBd", "Cd"]);
  });

  it("rewrites (?i:…), (?-i:…) and (?s:…) groups as plain groups", () => {
    expect(matches("x(?i:ab)y", "xABy XaBy xaby")).toEqual(["xABy", "xaby"]);
    expect(translateRegex("(?i)a(?-i:B)c")).toEqual({ source: "[aA](?:B)[cC]", flags: "" });
    expect(matches("(?i)a(?-i:B)c", "AbC aBC")).toEqual(["aBC"]);
    expect(matches("a(?s:.)b", "a\nb")).toEqual(["a\nb"]);
  });

  it("folds a negated class before negating it, as Go does", () => {
    expect(matches("(?:(?i)[^a-c])", "aAdD")).toEqual(["d", "D"]);
  });

  it("gives `.` and `\\s` Go's meaning", () => {
    expect(matches("a.b", "a\rb a\nb")).toEqual(["a\rb"]);
    expect(matches("a\\sb", "a\vb a b a\tb")).toEqual(["a\tb"]);
    expect(matches("a[^\\s]b", "a\vb a b")).toEqual(["a\vb"]);
    expect(matches("a\\Sb", "a\vb a b")).toEqual(["a\vb"]);
  });

  it("writes Go's any-character idiom (?:.|[\\n\\r]) as one class, which cannot backtrack on \\r", () => {
    expect(translateRegex("(?i)ab(?:.|[\\n\\r]){0,32}?c")).toEqual({ source: "ab[\\s\\S]{0,32}?c", flags: "i" });
    expect(translateRegex("a(?:[\\r\\n]|.)b").source).toBe("a[\\s\\S]b");
    expect(translateRegex("a(?:.|[\\r])b").source).toBe("a(?:[^\\n]|[\\r])b");
    expect(matches("a(?:.|[\\n\\r]){0,3}b", "a\r\nxb")).toEqual(["a\r\nxb"]);
    // 28 `\r` and no match: the two-branch form takes seconds here (it doubles with each one).
    const start = performance.now();
    expect(matches("x(?:.|[\\n\\r]){0,32}?y", `x${"\r".repeat(28)}`)).toEqual([]);
    expect(performance.now() - start).toBeLessThan(100);
  });

  it("rewrites what JavaScript would read differently: \\z, \\A, POSIX classes, (?P<name>", () => {
    expect(matches("ab\\z", "ab\nab")).toEqual(["ab"]);
    expect(matches("\\Aab", "ab ab")).toEqual(["ab"]);
    expect(matches("[[:alnum:]]+", "ab:12_c")).toEqual(["ab", "12", "c"]);
    expect(translateRegex("(?P<key>x)").source).toBe("(?<key>x)");
  });

  it("keeps a ] first in a class as a member, as Go does", () => {
    expect(matches("x[]a]", "x] xa xb")).toEqual(["x]", "xa"]);
    expect(matches("x[^]a]", "x] xa xb")).toEqual(["xb"]);
    expect(matches("(?i)x[]a]", "X] XA")).toEqual(["X]", "XA"]);
  });

  it("keeps escapes JavaScript reads the same way as written", () => {
    expect(translateRegex("[\\x60'\"]\\.\\-x\\x60").source).toBe("[\\x60'\"]\\.\\-x\\x60");
  });

  it("throws on syntax it cannot rewrite faithfully", () => {
    for (const go of ["\\pL", "\\Qa.b\\E", "(?U)a+", "a(?m)^b", "(?=a)", "[\\Sa]", "(a", "a)"]) expect(() => translateRegex(go), go).toThrow(/unsupported/);
  });
});

describe("parseToml", () => {
  it("reads the subset the rule file uses", () => {
    const toml = [
      "# comment",
      'title = "t" # trailing',
      "[[rules]]",
      'id = "a"',
      "regex = '''x\\y'''",
      "keywords = [",
      '    "k1", # one',
      "    'k2',",
      "]",
      'filter = """',
      'say "hi"\\tthere',
      '"""',
      "specificity = -70",
      "skipReport = true",
      'components = [{ id = "b", optional = true }, { id = "c" }]',
      "[[rules]]",
      'id = "b"',
      "[[rules.allowlists]]",
      "regexes = []",
    ].join("\n");
    expect(parseToml(toml)).toEqual({
      title: "t",
      rules: [
        { id: "a", regex: "x\\y", keywords: ["k1", "k2"], filter: 'say "hi"\tthere\n', specificity: -70, skipReport: true, components: [{ id: "b", optional: true }, { id: "c" }] },
        { id: "b", allowlists: [{ regexes: [] }] },
      ],
    });
  });

  it("throws on constructs outside that subset", () => {
    for (const toml of ["a.b = 1", "a = 1979-05-27", "a = 1\na = 2", 'a = "x', "a = 1 b"]) expect(() => parseToml(toml), toml).toThrow(/TOML line/);
  });
});

describe("convertRules", () => {
  const rule = (lines: string[]) => ["[[rules]]", 'description = "d"', 'confidence = "high"', ...lines].join("\n");

  it("reads v1 and v2 rule files the same way", () => {
    const v1 = rule(['id = "r"', "regex = '''(?i)k=([a-z]{8})'''", "secretGroup = 1", 'keywords = ["K="]', "filter = '''\nfilter.entropy(finding[\"secret\"]) < 3.5 || filter.tokenRatio(finding[\"secret\"]) >= 2.5\n'''"]);
    const v2 = rule(['id = "r"', "regex = '''(?i)k=([a-z]{8})'''", "valueGroup = 1", 'keywords = ["K="]', "filter = '''\nentropy(finding[\"secret\"]) < 3.5 || tokenRatio(finding[\"secret\"]) >= 2.5\n'''"]);
    const expected = { id: "r", regex: "k=([a-z]{8})", flags: "i", keywords: ["k="], confidence: "high", valueGroup: 1, entropy: [">=", 3.5], dropped: ["filter:tokenRatio"] };
    expect(convertRules(parseToml(v1)).rules).toEqual([expected]);
    expect(convertRules(parseToml(v2)).rules).toEqual([expected]);
  });

  it("strips validate, analyze and revoke, counting them", () => {
    const steps = ["validate", "analyze", "revoke"].map((k) => `${k} = '''\nlet r = http.get("https://example.invalid/" + finding["secret"])\n'''`);
    const conversion = convertRules(parseToml(rule(['id = "r"', "regex = '''abc'''", ...steps])));
    expect(conversion.rules).toEqual([{ id: "r", regex: "abc", flags: "", keywords: [], confidence: "high" }]);
    expect(conversion.stripped).toEqual({ validate: 1, analyze: 1, revoke: 1 });
  });

  it("skips path-scoped rules and keeps component-only ones, marked", () => {
    const toml = [rule(['id = "p"', "regex = '''abc'''", "path = '''\\.php$'''"]), rule(['id = "f"', "path = '''\\.p12$'''"]), rule(['id = "c"', "regex = '''abc'''", "skipReport = true"]), rule(['id = "s"', "regex = '''abc'''", 'components = [{ id = "c" }, { id = "o", optional = true }]'])].join("\n");
    const conversion = convertRules(parseToml(toml));
    expect(conversion.skipped.map((s) => s.id)).toEqual(["p", "f"]);
    expect(conversion.rules.map((r) => [r.id, r.componentOnly, r.dropped])).toEqual([
      ["c", true, undefined],
      ["s", undefined, ["component:c"]],
    ]);
  });

  it("skips a rule whose regex cannot be rewritten, with the reason", () => {
    const conversion = convertRules(parseToml(rule(['id = "r"', "regex = '''\\pLabc'''"])));
    expect(conversion.skipped).toEqual([{ id: "r", reason: "regex: unsupported escape \\p" }]);
  });

  it("throws on a key it does not know, so a new field is looked at before it is ignored", () => {
    expect(() => convertRules(parseToml(rule(['id = "r"', "regex = '''abc'''", "newField = 1"])))).toThrow(/unknown key newField/);
  });
});

describe("convertFilter", () => {
  it("keeps a lone entropy threshold, flipping it into what is kept", () => {
    expect(convertFilter('entropy(finding["secret"]) <= 3.8')).toEqual({ entropy: [">", 3.8], dropped: [] });
    expect(convertFilter('filter.entropy(finding["secret"]) < 3')).toEqual({ entropy: [">=", 3], dropped: [] });
  });

  it("keeps the entropy clause of an || chain and names the rest", () => {
    expect(convertFilter('matchesAny(finding["secret"], ["a||b"]) || entropy(finding["secret"]) < 3 || !matchesAny(finding["secret"], [`[0-9]`])')).toEqual({ entropy: [">=", 3], dropped: ["filter:matchesAny"] });
  });

  it("drops a filter that is more than one || chain", () => {
    expect(convertFilter('let x = entropy(finding["secret"]);\nx < 3')).toEqual({ dropped: ["filter"] });
    expect(convertFilter('entropy(finding["secret"]) < 3 || a ? b : c')).toEqual({ dropped: ["filter"] });
    expect(convertFilter('// note\nentropy(finding["secret"]) < 3')).toEqual({ dropped: ["filter"] });
  });
});
