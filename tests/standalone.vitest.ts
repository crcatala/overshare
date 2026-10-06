/**
 * The single-file HTML export (src/standalone.ts): the viewer inlined into one page, a session embedded
 * in it, and a CSP that allows exactly that page's own script and style.
 */
import { createHash } from "node:crypto";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EMBEDDED_SHARE_ID } from "../src/embedded.ts";
import { SESSION_MARKER, embedShare, inlineViewer, jsonForScript, standaloneContentSecurityPolicy } from "../src/standalone.ts";

const hash = (s: string) => `'sha256-${createHash("sha256").update(s).digest("base64")}'`;

/** What a Vite build of the viewer looks like, with the awkward bits the real bundle has. */
const INDEX = `<!doctype html>
<html lang="en">
  <head>
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'" />
    <title>Agent Session</title>
    <link rel="icon" href="./assets/favicon-abc.svg" type="image/svg+xml" />
    <script type="module" crossorigin src="./assets/index-abc.js"></script>
    <link rel="stylesheet" crossorigin href="./assets/index-abc.css">
  </head>
  <body>
    <main id="app"></main>
  </body>
</html>
`;
// A bundle quotes HTML: DOMPurify carries "</body></html>", others "</script>" and "<!--"; "$&" is a String.replace pattern.
const JS = 'const a="</body></html>";const b="</script><script>";const c="<!-- x -->";const d="$& $1 $`";//# sourceMappingURL=index-abc.js.map\n';
const CSS = '@font-face{font-family:F;src:url(./font-abc.woff2) format("woff2")}\nbody{background:url(#frag)}\n/*# sourceMappingURL=index-abc.css.map */';
const FONT = Buffer.from([0x77, 0x4f, 0x46, 0x32, 0, 1, 2, 3]);
const ICON = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>';

const assets = () =>
  new Map<string, Uint8Array | string>([
    ["index.html", INDEX],
    ["assets/index-abc.js", JS],
    ["assets/index-abc.css", CSS],
    ["assets/font-abc.woff2", FONT],
    ["assets/favicon-abc.svg", ICON],
  ]);

/** The body of the one element matching `tag`, as the browser would hash it. */
const inner = (html: string, tag: "script" | "style", attrs = "") => {
  const open = `<${tag}${attrs}>`;
  const start = html.indexOf(open) + open.length;
  return html.slice(start, html.indexOf(`</${tag}>`, start));
};

describe("inlineViewer", () => {
  it("leaves one inline script and style, no file references, and the session marker", () => {
    const out = inlineViewer(INDEX, assets());
    expect(out).not.toMatch(/<script[^>]*\ssrc=/);
    expect(out).not.toMatch(/<link\b(?![^>]*\bhref="data:)/);
    expect(out).not.toContain("sourceMappingURL");
    expect(out).not.toContain("./assets/");
    expect(out.split(SESSION_MARKER)).toHaveLength(2);
    expect(out.indexOf(SESSION_MARKER)).toBeGreaterThan(out.indexOf("<main"));
    expect(out).toContain("<title>Agent Session</title>");
  });

  it("inlines fonts as data URIs and keeps fragment references", () => {
    const css = inner(inlineViewer(INDEX, assets()), "style");
    expect(css).toContain(`url(data:font/woff2;base64,${FONT.toString("base64")})`);
    expect(css).toContain("url(#frag)");
  });

  it("inlines the tab icon as a data URI", () => {
    const out = inlineViewer(INDEX, assets());
    expect(out).toContain(`<link rel="icon" href="data:image/svg+xml;base64,${Buffer.from(ICON).toString("base64")}" type="image/svg+xml" />`);
    expect(out).not.toContain("favicon-abc.svg");
  });

  it("keeps the bundle's own look-alike text where it is (no `</body>`/`$&` surprises)", () => {
    const out = inlineViewer(INDEX, assets());
    const script = inner(out, "script", ' type="module"');
    // The text is still there, defanged: `</script` can't end the element, `<!--` can't open a comment.
    expect(script).toContain('const a="</body></html>"');
    expect(script).toContain('const b="<\\/script><script>"');
    expect(script).toContain('const c="<\\!-- x -->"');
    expect(script).toContain('const d="$& $1 $`"');
    // The marker is after the page's own </body>-less markup, not inside the script.
    expect(script).not.toContain(SESSION_MARKER);
    expect(out.indexOf(SESSION_MARKER)).toBeGreaterThan(out.indexOf("</script>"));
    expect(out.match(/<\/script>/g)).toHaveLength(1);
  });

  it("allows exactly the inline script and style, by hash", () => {
    const out = inlineViewer(INDEX, assets());
    const csp = out.match(/<meta http-equiv="Content-Security-Policy" content="([^"]*)"/g);
    expect(csp).toHaveLength(1);
    const policy = /content="([^"]*)"/.exec(csp![0])![1]!;
    expect(policy).toBe(standaloneContentSecurityPolicy(inner(out, "script", ' type="module"'), inner(out, "style")));
    const directives = policy.split("; ");
    expect(directives).toEqual(
      expect.arrayContaining([
        "default-src 'none'",
        `script-src ${hash(inner(out, "script", ' type="module"'))}`,
        `style-src ${hash(inner(out, "style"))}`,
        "connect-src 'none'",
        "font-src data:",
        "img-src data:",
        "base-uri 'none'",
        "form-action 'none'",
      ]),
    );
    expect(policy).not.toMatch(/unsafe|\*|https?:|'self'/);
  });

  it("refuses what it can't make self-contained", () => {
    const withChunk = assets();
    withChunk.set("assets/migration-1.js", "export default 1");
    expect(() => inlineViewer(INDEX, withChunk)).toThrow(/more than one script chunk/);

    const withImage = assets();
    withImage.set("assets/index-abc.css", "a{background:url(./x.png)}");
    expect(() => inlineViewer(INDEX, withImage)).toThrow(/not a font/);

    const missing = assets();
    missing.delete("assets/font-abc.woff2");
    expect(() => inlineViewer(INDEX, missing)).toThrow(/not in the build output/);

    expect(() => inlineViewer(INDEX.replace(/<link rel="stylesheet"[^>]*>/, ""), assets())).toThrow(/one script and one stylesheet/);

    expect(() => inlineViewer(INDEX.replace("favicon-abc.svg", "favicon-abc.gif"), assets())).toThrow(/not an image type/);

    const closesStyle = assets();
    closesStyle.set("assets/index-abc.css", "a::after{content:'</style>'}");
    expect(() => inlineViewer(INDEX, closesStyle)).toThrow(/<\/style/);
  });
});

describe("embedShare", () => {
  const template = inlineViewer(INDEX, assets());
  const nasty = {
    schema: "overshare/1",
    text: ["</script><script>alert(1)</script>", "<!-- <script>", "$& $1 $` $'", "line sep ", "</SCRIPT >", "]]>"].join("\n"),
  };

  /** What the viewer does: the element's text, parsed. */
  const read = (html: string) => {
    return JSON.parse(inner(html, "script", ` type="application/json" id="${EMBEDDED_SHARE_ID}"`)) as unknown;
  };

  it("round-trips text that would end or confuse a script element", () => {
    const out = embedShare(template, JSON.stringify(nasty));
    expect(read(out)).toEqual(nasty);
    // The element ends where we put its end: two script elements, so two closing tags.
    expect(out.match(/<\/script/gi)).toHaveLength(2);
    expect(out).not.toContain(SESSION_MARKER);
  });

  it("escapes only what must be escaped", () => {
    expect(jsonForScript('{"a":"<b> "}')).toBe('{"a":"\\u003cb>\\u2028"}');
    expect(JSON.parse(jsonForScript('{"a":"<b> "}'))).toEqual({ a: "<b> " });
  });

  it("refuses a template without exactly one marker", () => {
    expect(() => embedShare("<html></html>", "{}")).toThrow(/damaged/);
    expect(() => embedShare(template + SESSION_MARKER, "{}")).toThrow(/damaged/);
  });
});

describe("the real viewer build", () => {
  it("inlines into a page with no external references", async () => {
    const { build } = await import("vite");
    const result = await build({ configFile: join(import.meta.dirname, "..", "vite.config.ts"), logLevel: "silent", build: { write: false } });
    const outputs = (Array.isArray(result) ? result : [result]) as { output: { fileName: string; source?: unknown; code?: string }[] }[];
    const files = new Map<string, Uint8Array | string>();
    for (const f of outputs.flatMap((o) => o.output)) if (!f.fileName.endsWith(".map")) files.set(f.fileName, (f.code ?? f.source) as Uint8Array | string);

    const page = embedShare(inlineViewer(String(files.get("index.html")), files), JSON.stringify({ schema: "overshare/1" }));

    // The page's own markup: the bundle quotes HTML in its strings (`<img src="${x}">`), which is text, not markup.
    const skeleton = page.replace(inner(page, "script", ' type="module"'), "").replace(inner(page, "style"), "").replace(inner(page, "script", ` type="application/json" id="${EMBEDDED_SHARE_ID}"`), "");
    // The one reference left is the tab icon, as a data: URI.
    expect(skeleton).toMatch(/<link rel="icon" href="data:image\/svg\+xml;base64,/);
    expect(skeleton).not.toMatch(/\s(src|href)="(?!data:)/i);
    expect(skeleton).not.toMatch(/<(img|iframe|object|embed)\b|<link\b(?![^>]*\bhref="data:)/i);
    expect(inner(page, "style")).not.toMatch(/url\((?!data:|#)/);
    expect(page.includes("sourceMappingURL")).toBe(false);
    // Whatever the bundle quotes, only our own two elements (the viewer, the session) start or end a script. Counts, not
    // the page, are compared: a failure would print a megabyte.
    expect(page.match(/<\/script/gi)?.length).toBe(2);
    expect(page.match(/<script[\s>]/gi)?.length).toBeGreaterThanOrEqual(2);
    const csp = /Content-Security-Policy" content="([^"]*)"/.exec(page)![1]!;
    expect(csp).toContain(`script-src ${hash(inner(page, "script", ' type="module"'))}`);
    expect(csp).toContain(`style-src ${hash(inner(page, "style"))}`);
  }, 30_000);
});
