import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error — plain ESM build helper without type declarations
import { contentSecurityPolicy, deployFiles, loadViewerConfig } from "../viewer/config.mjs";

function configFile(content: unknown): string {
  const file = join(mkdtempSync(join(tmpdir(), "as-vc-")), "viewer.config.json");
  writeFileSync(file, JSON.stringify(content));
  return file;
}

describe("viewer build config", () => {
  it("adds configured source origins to the CSP", () => {
    const { sources } = loadViewerConfig(configFile({ sources: { r2: "https://shares.example.com/s/{id}.json" } }));
    const csp = contentSecurityPolicy(sources, { header: true });
    expect(csp).toContain("connect-src 'self' https://api.github.com https://gist.githubusercontent.com https://shares.example.com");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(contentSecurityPolicy(sources)).not.toContain("frame-ancestors");
  });

  it("only loosens the policy for the Vite dev server", () => {
    const prod = contentSecurityPolicy({});
    const dev = contentSecurityPolicy({}, { dev: true });
    expect(prod).toContain("style-src 'self';");
    expect(prod).not.toContain("ws:");
    expect(dev).toContain("style-src 'self' 'unsafe-inline'");
    expect(dev).toMatch(/connect-src [^;]* ws: wss:/);
    expect(deployFiles({})._headers).toContain(contentSecurityPolicy({}, { header: true }));
    expect(deployFiles({})._redirects).toBe("/ /session/ 302\n");
  });

  it.each([
    [{ sources: { gist: "https://x/{id}" } }, /invalid source name/],
    [{ sources: { r2: "https://x/static.json" } }, /containing \{id\}/],
    [{ sources: { r2: "http://example.com/{id}.json" } }, /must use https/],
  ])("rejects invalid config %#", (content, error) => {
    expect(() => loadViewerConfig(configFile(content))).toThrow(error);
  });

  it("treats a missing config as no extra sources", () => {
    expect(loadViewerConfig(join(tmpdir(), "does-not-exist.json"))).toEqual({ sources: {} });
  });
});

describe("viewer build", () => {
  // The CSP is what blocks scripts and remote requests the sanitizer doesn't know about,
  // and a build without it still looks and works the same, so check the real build output.
  it("ships the CSP in index.html ahead of any script", async () => {
    const { build } = await import("vite");
    const result = await build({ configFile: join(import.meta.dirname, "..", "vite.config.ts"), logLevel: "silent", build: { write: false } });
    const outputs = (Array.isArray(result) ? result : [result]) as { output: { fileName: string; source?: unknown }[] }[];
    const source = String(outputs.flatMap((o) => o.output).find((f) => f.fileName === "index.html")?.source ?? "");
    const csp = source.match(/<meta http-equiv="Content-Security-Policy" content="([^"]*)"/)?.[1];

    expect(source).not.toContain("{{CSP}}");
    expect(csp).toBe(contentSecurityPolicy(loadViewerConfig().sources));
    expect(csp?.split("; ")).toEqual(
      expect.arrayContaining(["default-src 'none'", "script-src 'self'", "style-src 'self'", "img-src 'self' data:", "font-src 'self'", "base-uri 'none'", "form-action 'none'"]),
    );
    expect(source.indexOf("Content-Security-Policy")).toBeLessThan(source.indexOf("<script"));
  }, 30_000);
});

describe("viewer share links", () => {
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).__AGENT_SHARE_SOURCES__;
  });

  it("parses configured sources, gists and local files", async () => {
    (globalThis as Record<string, unknown>).__AGENT_SHARE_SOURCES__ = { r2: "https://shares.example.com/s/{id}.json" };
    const { parseHash, formatHash } = await import("../viewer/src/source.ts");
    expect(parseHash("#r2:AbCdEfGhIjKlMnOpQrStUv&ui=brief")).toMatchObject({
      source: { kind: "configured", source: "r2", id: "AbCdEfGhIjKlMnOpQrStUv" },
    });
    expect(parseHash("#r2:AbCdEfGhIjKlMnOpQrStUv&ui=brief").params.get("ui")).toBe("brief");
    expect(parseHash("#octo/5260b8cf9b1baae31a40717ac1ab5f08").source).toEqual({ kind: "raw-gist", owner: "octo", id: "5260b8cf9b1baae31a40717ac1ab5f08" });
    expect(parseHash("#local:x.json").source).toEqual({ kind: "local", name: "x.json" });
    const state = parseHash("#r2:AbCdEfGhIjKlMnOpQrStUv&turn=3");
    expect(formatHash(state)).toBe("#r2:AbCdEfGhIjKlMnOpQrStUv&turn=3");
  });

  // Regression: names were written raw, so `&` cut a copied link short and `%` made the
  // viewer throw (URIError) when the rewritten address was read back on reload.
  it("writes local names and url paths so they read back whole, through a real URL", async () => {
    const { parseHash, formatHash } = await import("../viewer/src/source.ts");
    const trip = (source: Parameters<typeof formatHash>[0]["source"]) =>
      parseHash(new URL(formatHash({ source, params: new URLSearchParams({ turn: "2" }) }), "https://v.example/session/").hash);
    for (const name of ["a&b.json", "100%.json", "x#y.json", "b c.json", "a%20b.json", "ünï.json"]) {
      const back = trip({ kind: "local", name });
      expect(back.source).toEqual({ kind: "local", name });
      expect(back.params.get("turn")).toBe("2");
    }
    expect(trip({ kind: "url", path: "/shares/a&b.json?v=1" }).source).toEqual({ kind: "url", path: "/shares/a&b.json?v=1" });
    expect(formatHash({ source: { kind: "url", path: "/shares/x.json" }, params: new URLSearchParams() })).toBe("#url:/shares/x.json");
  });
});
