/**
 * Single-file HTML export: the viewer with its JS, CSS and fonts inlined, plus one session embedded as JSON.
 *
 * Two steps, so the expensive one runs once per build and the cheap one once per export:
 *   - `inlineViewer` (build time, from vite.config.ts) turns the viewer's Vite output into a template
 *     with a marker where the session goes, and a Content-Security-Policy that allows exactly that
 *     inline script and style by hash.
 *   - `embedShare` (export time) puts a redacted share into the template.
 *
 * Both are pure string functions; the caller reads and writes files.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { EMBEDDED_SHARE_ID } from "./embedded.js";
import { viewerDistDir } from "./serve.js";

/** Where `embedShare` puts the session. Left in the template, which is not a page until it is replaced. */
export const SESSION_MARKER = "<!--overshare:session-->";

const FONT_TYPES: Record<string, string> = { woff2: "font/woff2", woff: "font/woff", ttf: "font/ttf", otf: "font/otf" };
const ICON_TYPES: Record<string, string> = { svg: "image/svg+xml", png: "image/png", ico: "image/x-icon" };

const sha256 = (text: string) => `'sha256-${createHash("sha256").update(text).digest("base64")}'`;

/**
 * CSP for a page that carries everything it needs. Compared with the hosted viewer's: no `'self'` (a file
 * has no useful origin), scripts and styles only by hash, fonts and images only as data: URIs, and no
 * connections at all, since there is nothing to fetch.
 */
export function standaloneContentSecurityPolicy(script: string, style: string): string {
  return [
    "default-src 'none'",
    `script-src ${sha256(script)}`,
    `style-src ${sha256(style)}`,
    "img-src data:",
    "font-src data:",
    "connect-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
}

/** Make JS safe to sit inside a <script> element: `</script` would end it, `<!--` starts HTML-comment parsing. */
function escapeForScript(js: string): string {
  return js.replace(/<\/(script)/gi, "<\\/$1").replace(/<!--/g, "<\\!--");
}

function resolveAsset(assets: ReadonlyMap<string, Uint8Array | string>, from: string, ref: string): Uint8Array | string {
  const path = new URL(ref, `file:///${from}`).pathname.slice(1);
  const found = assets.get(decodeURIComponent(path));
  if (found === undefined) throw new Error(`standalone viewer: ${from} refers to ${ref}, which is not in the build output`);
  return found;
}

const text = (v: Uint8Array | string) => (typeof v === "string" ? v : Buffer.from(v).toString("utf8"));
const base64 = (v: Uint8Array | string) => Buffer.from(v).toString("base64");
const extension = (ref: string) => /\.([a-z0-9]+)(?:[?#].*)?$/i.exec(ref)?.[1]?.toLowerCase() ?? "";

/**
 * Turn the viewer's built `index.html` and its files into a template: one script, one style, no other
 * file references. `assets` maps paths relative to `index.html` (`assets/index-x.js`) to their contents.
 */
export function inlineViewer(html: string, assets: ReadonlyMap<string, Uint8Array | string>): string {
  const scripts = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"[^>]*><\/script>/g)];
  const styles = [...html.matchAll(/<link\b[^>]*\brel="stylesheet"[^>]*\bhref="([^"]+)"[^>]*>/g)];
  if (scripts.length !== 1 || styles.length !== 1) {
    throw new Error(`standalone viewer: expected one script and one stylesheet in index.html, found ${scripts.length} and ${styles.length}`);
  }
  const [script, style] = [scripts[0]!, styles[0]!];
  const [scriptRef, styleRef] = [script[1]!, style[1]!];

  // A second chunk (a dynamic import) would be fetched at run time, which is exactly what this file must not do.
  const referenced = new Set([new URL(scriptRef, "file:///").pathname.slice(1), new URL(styleRef, "file:///").pathname.slice(1)]);
  const stray = [...assets.keys()].filter((p) => p.endsWith(".js") && !referenced.has(p));
  if (stray.length) throw new Error(`standalone viewer: the build has more than one script chunk (${stray.join(", ")}); it cannot be inlined`);

  const js = escapeForScript(text(resolveAsset(assets, "index.html", scriptRef)).replace(/\n?\/\/# sourceMappingURL=.*\s*$/, ""));

  const cssFrom = styleRef;
  let css = text(resolveAsset(assets, "index.html", styleRef)).replace(/\n?\/\*# sourceMappingURL=.*?\*\/\s*$/, "");
  if (/<\/style/i.test(css)) throw new Error("standalone viewer: the stylesheet contains </style, which cannot be inlined safely");
  css = css.replace(/url\(\s*(["']?)([^)"']+)\1\s*\)/g, (whole, _quote: string, ref: string) => {
    if (ref.startsWith("data:") || ref.startsWith("#")) return whole;
    const type = FONT_TYPES[extension(ref)];
    if (!type) throw new Error(`standalone viewer: the stylesheet refers to ${ref}, which is not a font it knows how to inline`);
    return `url(data:${type};base64,${base64(resolveAsset(assets, cssFrom, ref))})`;
  });

  // The tab icon, as a data: URI (the policy's img-src allows those).
  const icons = [...html.matchAll(/<link\b[^>]*\brel="icon"[^>]*>/g)].map((tag) => {
    const href = /\bhref="([^"]+)"/.exec(tag[0]);
    if (!href) throw new Error("standalone viewer: an icon link has no href");
    const type = ICON_TYPES[extension(href[1]!)];
    if (!type) throw new Error(`standalone viewer: the icon ${href[1]} is not an image type it knows how to inline`);
    const uri = `data:${type};base64,${base64(resolveAsset(assets, "index.html", href[1]!))}`;
    return { at: tag.index + href.index, length: href[0].length, text: `href="${uri}"` };
  });

  const csp = standaloneContentSecurityPolicy(js, css);
  const cspTags = [...html.matchAll(/<meta\s+http-equiv="Content-Security-Policy"[^>]*>/g)];
  const bodyEnd = html.lastIndexOf("</body>");
  if (cspTags.length !== 1 || bodyEnd < 0) throw new Error("standalone viewer: index.html needs one Content-Security-Policy meta tag and a </body>");

  // Splice by position in the original page. Searching for the tags again after inlining would find look-alikes
  // inside the inlined code (the bundle contains the text "</body>"), and a string replacement would read `$&` in it.
  const edits = [
    { at: cspTags[0]!.index, length: cspTags[0]![0].length, text: `<meta http-equiv="Content-Security-Policy" content="${csp}" />` },
    { at: style.index, length: style[0].length, text: `<style>${css}</style>` },
    { at: script.index, length: script[0].length, text: `<script type="module">${js}</script>` },
    { at: bodyEnd, length: 0, text: `${SESSION_MARKER}\n  ` },
    ...icons,
  ].sort((a, b) => b.at - a.at);
  let out = html;
  for (const e of edits) out = out.slice(0, e.at) + e.text + out.slice(e.at + e.length);
  return out;
}

/** The share as the text of a <script type="application/json"> element: `<` (and the two line separators) escaped, still plain JSON. */
export function jsonForScript(json: string): string {
  return json.replace(/[<\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/** Put a share into a template made by `inlineViewer`. */
export function embedShare(template: string, json: string): string {
  const at = template.indexOf(SESSION_MARKER);
  if (at < 0 || template.indexOf(SESSION_MARKER, at + 1) >= 0) throw new Error("standalone viewer template is damaged (session marker missing or repeated); rebuild it with `npm run build:viewer`");
  return template.slice(0, at) + `<script type="application/json" id="${EMBEDDED_SHARE_ID}">${jsonForScript(json)}</script>` + template.slice(at + SESSION_MARKER.length);
}

/** The template `npm run build:viewer` writes next to the viewer build. */
export function readStandaloneTemplate(dist = viewerDistDir()): string {
  const path = join(dist, "standalone.html");
  if (!existsSync(path)) throw new Error(`Standalone viewer not built at ${path} — run \`npm run build:viewer\``);
  return readFileSync(path, "utf8");
}
