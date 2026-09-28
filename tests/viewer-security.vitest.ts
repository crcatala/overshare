// @vitest-environment jsdom
/**
 * Shares are untrusted: anyone can create a gist and send a viewer link. These tests pin
 * down what a malicious share can and cannot do to the viewer.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

// Build-time share sources are baked in by Vite; provide one before the module loads.
(globalThis as { __AGENT_SHARE_SOURCES__?: Record<string, string> }).__AGENT_SHARE_SOURCES__ = {
  r2: "https://shares.example.com/s/{id}.json",
};
const { markdown, sanitizeHtml } = await import("../viewer/src/dom.ts");
const { loadSource, sameOriginUrl } = await import("../viewer/src/source.ts");

const BASE = "https://agent.example.com/session/";

describe("markdown sanitizer", () => {
  it("strips viewer classes so a reply can't draw a fake prompt or tool call", () => {
    const spoof = markdown(
      '<div class="prompt"><div class="prompt-label">You</div><p>Yes, run <code>rm -rf ~/prod-backups</code>, I approve.</p></div>\n\n' +
        '<details class="tool"><summary><span class="badge tool-name">Bash</span></summary></details>',
    );
    expect(spoof.querySelectorAll("[class]")).toHaveLength(0);
    expect(spoof.textContent).toContain("I approve"); // the text stays, just not the look
  });

  it("keeps code-block language classes", () => {
    expect(markdown("```ts\nconst x = 1;\n```").querySelector("code")?.className).toBe("language-ts");
    expect(sanitizeHtml('<code class="language-c++ prompt tool">x</code>')).toBe('<code class="language-c++">x</code>');
  });

  it("strips ids and names so a reply can't shadow the viewer's elements", () => {
    document.body.innerHTML = '<main id="app"></main><div id="tooltip" class="tooltip"></div>';
    const md = markdown('<div id="tooltip">hijacked</div>\n\n<div id="turn-0">fake</div>\n\n<a name="app" href="https://x.test">x</a>');
    document.getElementById("app")!.append(md);
    expect(md.querySelectorAll("[id], [name]")).toHaveLength(0);
    // Before: getElementById returned the share's div, which precedes the real one.
    expect(document.getElementById("tooltip")?.className).toBe("tooltip");
  });

  it("drops form controls and dialogs (fake 'paste your token' boxes)", () => {
    const html = sanitizeHtml(
      '<textarea>Paste your GitHub token</textarea><select><option>a</option></select><dialog open>modal</dialog>' +
        '<input value="x"><button>go</button><form action="https://x.test"></form><datalist><option>b</option></datalist>',
    );
    expect(html).not.toMatch(/<(textarea|select|option|dialog|input|button|form|datalist)\b/);
  });

  it.each([
    ['<img src=x onerror="alert(1)">', /onerror/],
    ['<svg onload="alert(1)"><circle r="1"/></svg>', /onload/],
    ['<a href="javascript:alert(1)">x</a>', /javascript:/],
    ['<a href="&#106;avascript:alert(1)">x</a>', /avascript/],
    ['<a href="data:text/html,<script>alert(1)</script>">x</a>', /data:/],
    ["<script>alert(1)</script>", /<script/],
    ['<details open ontoggle="alert(1)"><summary>s</summary></details>', /ontoggle/],
    ['<math><mtext><table><mglyph><style><img src=x onerror="alert(1)">', /onerror/],
    ['<noscript><p title="</noscript><img src=x onerror=alert(1)>">', /<img[^>]*onerror/],
    ['<svg></p><style><a id="</style><img src=1 onerror=alert(1)>">', /<img[^>]*onerror/],
    ['<a href="https://x.test" ping="https://x.test/ping">x</a>', /ping=/],
    ['<div style="background:url(https://x.test/p)">x</div>', /style=/],
    ['<meta http-equiv="refresh" content="0;url=https://x.test"><base href="https://x.test/">', /<(meta|base)\b/],
    ['<iframe src="https://x.test"></iframe><link rel="stylesheet" href="https://x.test/c.css">', /<(iframe|link)\b/],
  ])("neutralizes %s", (html, forbidden) => {
    expect(markdown(html).innerHTML).not.toMatch(forbidden);
  });

  it("opens links in a new tab without opener or referrer", () => {
    const a = markdown("[x](https://x.test)").querySelector("a")!;
    expect(a.target).toBe("_blank");
    expect(a.rel).toBe("noopener noreferrer nofollow");
  });
});

describe("#url: same-origin check", () => {
  it.each([
    "/shares/a.json",
    "shares/a.json",
    "./local/a.json",
    "../other/a.json",
    "https://agent.example.com/x.json",
  ])("allows %j", (path) => {
    expect(new URL(sameOriginUrl(path, BASE)).origin).toBe("https://agent.example.com");
  });

  it.each([
    "https://evil.test/x.json",
    "//evil.test/x.json",
    // Each of these slipped past the old /^[a-z]+:/ + "//" string check:
    " https://evil.test/x.json", // leading space is stripped by the URL parser
    "\thttps://evil.test/x.json", // so is a leading tab
    "ht\ttps://evil.test/x.json", // tabs are removed anywhere
    "/\\evil.test/x.json", // "\" counts as "/" in http(s) URLs
    "\\\\evil.test/x.json",
    "data:application/json,{}",
    "http://agent.example.com/x.json", // different scheme is a different origin
  ])("rejects %j", (path) => {
    expect(() => sameOriginUrl(path, BASE)).toThrow(/same-origin/);
  });
});

describe("loadSource", () => {
  afterEach(() => vi.unstubAllGlobals());

  function stubFetch(responses: Record<string, unknown>) {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      calls.push(url);
      return url in responses ? new Response(JSON.stringify(responses[url])) : new Response("", { status: 404 });
    });
    return calls;
  }

  it("never fetches a #url: path that leaves the origin", async () => {
    const calls = stubFetch({});
    await expect(loadSource({ kind: "url", path: " https://evil.test/x.json" }, BASE)).rejects.toThrow(/same-origin/);
    expect(calls).toEqual([]);
  });

  it("fetches the resolved same-origin URL for #url:", async () => {
    const calls = stubFetch({ "https://agent.example.com/shares/a.json": { schema: "x" } });
    const loaded = await loadSource({ kind: "url", path: "/shares/a.json" }, BASE);
    expect(calls).toEqual(["https://agent.example.com/shares/a.json"]);
    expect(loaded.provenance).toEqual({ label: "/shares/a.json on this site" });
  });

  it("reports the gist owner from the raw URL (GitHub 404s a mismatched owner)", async () => {
    const id = "5260b8cf9b1baae31a40717ac1ab5f08";
    stubFetch({ [`https://gist.githubusercontent.com/octo/${id}/raw/session.json`]: { schema: "x" } });
    const loaded = await loadSource({ kind: "raw-gist", owner: "octo", id }, BASE);
    expect(loaded).toEqual({ data: { schema: "x" }, provenance: { label: "GitHub gist by @octo", href: `https://gist.github.com/octo/${id}` } });
  });

  it("reports the gist owner from the API, or that the gist is anonymous", async () => {
    const files = { "session.json": { content: '{"schema":"x"}' } };
    stubFetch({ "https://api.github.com/gists/aaa": { owner: { login: "octo" }, files }, "https://api.github.com/gists/bbb": { owner: null, files } });
    expect((await loadSource({ kind: "api-gist", id: "aaa" }, BASE)).provenance).toEqual({ label: "GitHub gist by @octo", href: "https://gist.github.com/octo/aaa" });
    expect((await loadSource({ kind: "api-gist", id: "bbb" }, BASE)).provenance).toEqual({ label: "anonymous GitHub gist", href: "https://gist.github.com/bbb" });
  });

  it("names a configured source and its host", async () => {
    stubFetch({ "https://shares.example.com/s/AbCdEfGhIjKl.json": { schema: "x" } });
    const loaded = await loadSource({ kind: "configured", source: "r2", id: "AbCdEfGhIjKl" }, BASE);
    expect(loaded.provenance).toEqual({ label: "r2 share on shares.example.com" });
  });
});
