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

describe("viewer share links", () => {
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).__AGENT_SHARE_SOURCES__;
  });

  it("parses configured sources, gists and local files", async () => {
    (globalThis as Record<string, unknown>).__AGENT_SHARE_SOURCES__ = { r2: "https://shares.example.com/s/{id}.json" };
    const { parseHash, formatHash } = await import("../viewer/src/source.ts");
    expect(parseHash("#r2:AbCdEfGhIjKlMnOpQrStUv&view=brief")).toMatchObject({
      source: { kind: "configured", source: "r2", id: "AbCdEfGhIjKlMnOpQrStUv" },
    });
    expect(parseHash("#r2:AbCdEfGhIjKlMnOpQrStUv&view=brief").params.get("view")).toBe("brief");
    expect(parseHash("#octo/5260b8cf9b1baae31a40717ac1ab5f08").source).toEqual({ kind: "raw-gist", owner: "octo", id: "5260b8cf9b1baae31a40717ac1ab5f08" });
    expect(parseHash("#local:x.json").source).toEqual({ kind: "local", name: "x.json" });
    const state = parseHash("#r2:AbCdEfGhIjKlMnOpQrStUv&view=minimal");
    expect(formatHash(state)).toBe("#r2:AbCdEfGhIjKlMnOpQrStUv&view=minimal");
  });
});
