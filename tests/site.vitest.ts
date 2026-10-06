import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EXAMPLE_SHARE_PATH, exampleShare } from "../src/fixtures/index.js";
import { formatBytes } from "../src/format.js";
import { SHARE_MODES } from "../src/schema.js";
// @ts-expect-error — plain ESM build helper without type declarations
import { contentSecurityPolicy, deployFiles, siteContentSecurityPolicy } from "../viewer/config.mjs";

const repo = join(import.meta.dirname, "..");

/** `_headers` as { path pattern: header lines }. */
function headerRules(text: string): Record<string, string[]> {
  const rules: Record<string, string[]> = {};
  let current = "";
  for (const line of text.split("\n").filter(Boolean)) {
    if (!line.startsWith(" ")) rules[(current = line)] = [];
    else rules[current]!.push(line.trim());
  }
  return rules;
}

/**
 * Selectors whose `animation` is not switched off by a *later* `prefers-reduced-motion` rule. Order matters:
 * a reduce block above the animation it targets loses to it (equal specificity, later rule wins).
 */
function motionGaps(source: string): string[] {
  const css = source.replace(/\/\*[\s\S]*?\*\//g, "");
  const reduce: { start: number; end: number }[] = [];
  for (const m of css.matchAll(/@media \(prefers-reduced-motion: reduce\)\s*\{/g)) {
    let depth = 1;
    let i = m.index + m[0].length;
    while (depth && i < css.length) depth += css[i] === "{" ? 1 : css[i] === "}" ? -1 : 0, i++;
    reduce.push({ start: m.index, end: i });
  }
  const inReduce = (pos: number) => reduce.some((r) => pos >= r.start && pos < r.end);
  const rules = [...css.matchAll(/([^{}@]+)\{([^{}]*)\}/g)].map((m) => ({ pos: m.index, selectors: m[1]!.split(",").map((x) => x.trim()), body: m[2]! }));
  const off = rules.filter((r) => inReduce(r.pos) && /(?:^|[;\s])animation\s*:\s*none/.test(r.body));
  const gaps = new Set<string>();
  for (const rule of rules) {
    if (inReduce(rule.pos)) continue;
    const value = rule.body.match(/(?:^|[;\s])animation\s*:\s*([^;]+)/)?.[1]?.trim();
    if (!value || value === "none") continue;
    for (const sel of rule.selectors) if (!off.some((o) => o.pos > rule.pos && o.selectors.includes(sel))) gaps.add(sel);
  }
  return [...gaps];
}

describe("deploy files with the landing page", () => {
  const files = deployFiles({}, { site: true }) as Record<string, string>;
  const rules = headerRules(files._headers!);

  it("serves the landing page at / instead of redirecting to the viewer", () => {
    expect(files._redirects).toBe("");
    expect((deployFiles({}) as Record<string, string>)._redirects).toBe("/ /s/ 302\n");
  });

  it("keeps only the viewer out of search engines", () => {
    expect(files["robots.txt"]).toBe("User-agent: *\nDisallow: /s/\n");
    expect(rules["/s/*"]).toContain("X-Robots-Tag: noindex, nofollow");
    expect(rules["/"]).not.toContain("X-Robots-Tag: noindex, nofollow");
  });

  // Cloudflare joins the values of every rule that matches a path, and two joined CSPs are both enforced.
  it("gives each page exactly one policy, from rules that never overlap", () => {
    expect(Object.keys(rules)).toEqual(["/s/*", "/", "/assets/*"]);
    expect(rules["/s/*"]).toContain(`Content-Security-Policy: ${contentSecurityPolicy({}, { header: true })}`);
    expect(rules["/"]).toContain(`Content-Security-Policy: ${siteContentSecurityPolicy({ header: true })}`);
    expect(rules["/assets/*"]!.some((h) => h.startsWith("Content-Security-Policy"))).toBe(false);
  });
});

describe("landing page build", () => {
  it("ships a same-origin CSP and no inline code, and links to the example session", async () => {
    const { build } = await import("vite");
    const result = await build({ configFile: join(repo, "vite.site.config.ts"), logLevel: "silent", build: { write: false } });
    const outputs = (Array.isArray(result) ? result : [result]) as { output: { fileName: string; source?: unknown }[] }[];
    const html = String(outputs.flatMap((o) => o.output).find((f) => f.fileName === "index.html")?.source ?? "");

    const csp = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]*)"/)?.[1];
    expect(csp).toBe(siteContentSecurityPolicy());
    expect(html.indexOf("Content-Security-Policy")).toBeLessThan(html.indexOf("<script"));
    // style-src and script-src are 'self' only: inline code would be blocked in production.
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
    expect(html).not.toMatch(/<style[\s>]/);
    expect(html).not.toMatch(/\sstyle="/);
    expect(html).toContain(`href="/s/#url:${EXAMPLE_SHARE_PATH}"`);

    // The bitmap icons are served from the root by name; the SVG goes through the build like other assets.
    expect(html).toContain('<link rel="icon" href="/favicon.ico" sizes="32x32" />');
    expect(html).toMatch(/<link rel="icon" href="\/assets\/logo-[\w-]+\.svg" type="image\/svg\+xml" \/>/);
    expect(html).toContain('<link rel="apple-touch-icon" href="/apple-touch-icon.png" />');

    // The size ledger rows are controls: they must be buttons, so keyboard and screen-reader users get them too.
    const rows = [...html.matchAll(/<(\w+)[^>]*\sdata-kb-row="/g)];
    expect(rows.length).toBe(SHARE_MODES.length);
    for (const [, tag] of rows) expect(tag).toBe("button");

    // Every in-page link has a target.
    const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
    for (const [, target] of html.matchAll(/href="#([^"]+)"/g)) expect(ids, `#${target}`).toContain(target);
  }, 30_000);

  // The page links them at the root, so the build must copy site/public/ there. A write build would touch the real
  // viewer/dist, so check the resolved config instead: Vite copies publicDir into the root of outDir.
  it("copies the bitmap icons to the root of the deploy", async () => {
    const { resolveConfig } = await import("vite");
    const config = await resolveConfig({ configFile: join(repo, "vite.site.config.ts"), logLevel: "silent" }, "build");
    expect(config.publicDir).toBe(join(repo, "site/public"));
    expect(config.build.outDir).toBe(join(repo, "viewer/dist"));
    for (const file of ["favicon.ico", "apple-touch-icon.png"]) expect(existsSync(join(config.publicDir, file)), file).toBe(true);
  });

  it("gives the viewer the same tab icon as the landing page", () => {
    expect(readFileSync(join(repo, "viewer/src/favicon.svg"), "utf8")).toBe(readFileSync(join(repo, "site/logo.svg"), "utf8"));
  });

  it("switches off every animation under prefers-reduced-motion, with the override after it", () => {
    // The checker itself: an override above its animation, or none at all, is reported.
    const reduceNone = "@media (prefers-reduced-motion: reduce) { .a { animation: none; } }";
    expect(motionGaps(`.a { animation: x 1s; } ${reduceNone}`)).toEqual([]);
    expect(motionGaps(`${reduceNone} .a { animation: x 1s; }`)).toEqual([".a"]);
    expect(motionGaps(".a { animation: x 1s; }")).toEqual([".a"]);
    expect(motionGaps(`.a { animation: x 1s; } ${reduceNone} .b { animation: y 1s; }`)).toEqual([".b"]);

    expect(motionGaps(readFileSync(join(repo, "site/src/site.css"), "utf8"))).toEqual([]);
  });

  it("quotes the example session's real share-file size for every mode", () => {
    const script = readFileSync(join(repo, "site/src/main.ts"), "utf8");
    for (const mode of SHARE_MODES) {
      const quoted = script.match(new RegExp(`${mode}: \\{[^}]*kb: ([\\d.]+) \\}`))?.[1];
      expect(`${quoted} KB`, mode).toBe(formatBytes(exampleShare({ mode }).report.bytes));
    }
  });
});
