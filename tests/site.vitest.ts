import { readFileSync } from "node:fs";
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

    // Every in-page link has a target.
    const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
    for (const [, target] of html.matchAll(/href="#([^"]+)"/g)) expect(ids, `#${target}`).toContain(target);
  }, 30_000);

  it("quotes the example session's real share-file size for every mode", () => {
    const script = readFileSync(join(repo, "site/src/main.ts"), "utf8");
    for (const mode of SHARE_MODES) {
      const quoted = script.match(new RegExp(`${mode}: \\{[^}]*kb: ([\\d.]+) \\}`))?.[1];
      expect(`${quoted} KB`, mode).toBe(formatBytes(exampleShare({ mode }).report.bytes));
    }
  });
});
