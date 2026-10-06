import { EMBEDDED_SHARE_ID } from "../../src/embedded.ts";

/**
 * Where a share lives, parsed from the URL hash (never sent to the server):
 *   #<owner>/<gistId>     secret gist via raw URL (no API rate limit)  ← what `publish` emits
 *   #gist:<gistId>        gist via the GitHub API (60 req/h/IP unauthenticated)
 *   #<32-hex gistId>      same as gist:
 *   #local:<name>         file served by `overshare serve` at ./local/<name>
 *   #url:<path>           same-origin path
 *   #<source>:<id>        a source configured at build time in viewer.config.json,
 *                         e.g. #r2:<id> → https://shares.example.com/s/<id>.json
 *
 * A single-file HTML export (`overshare export --format html`) carries its session in the page. It has no
 * hash form: a link can't ask for it (so the hosted viewer can't be pointed at some page's element), and
 * `embeddedSource` supplies it only when the page has one and the hash names nothing else.
 *
 * Extra `&key=value` params follow the source, e.g. `&turn=3`. Local names and `url:`
 * paths are written with `%`, `&` and `#` escaped, so they read back whole.
 */
export type Source =
  | { kind: "raw-gist"; owner: string; id: string }
  | { kind: "api-gist"; id: string }
  | { kind: "local"; name: string }
  | { kind: "url"; path: string }
  | { kind: "configured"; source: string; id: string }
  | { kind: "embedded" };

/** Share sources baked in by vite.config.ts from viewer.config.json. */
declare const __OVERSHARE_SOURCES__: Record<string, string>;
const SOURCES: Record<string, string> = typeof __OVERSHARE_SOURCES__ === "undefined" ? {} : __OVERSHARE_SOURCES__;
const SHARE_ID = /^[A-Za-z0-9_-]{8,128}$/;
const GIST_HOSTS = new Set(["gist.github.com", "gist.githubusercontent.com"]);
const GIST_ID = /^[0-9a-f]{20,}$/i;
const GIST_OWNER = /^[\w-]+$/;

export interface HashState {
  source?: Source;
  params: URLSearchParams;
}

export function parseHash(hash: string): HashState {
  const raw = hash.replace(/^#/, "");
  const [head = "", ...rest] = raw.split("&");
  const params = new URLSearchParams(rest.join("&"));
  let src: string;
  try {
    src = decodeURIComponent(head);
  } catch {
    // A malformed escape (a stray %) names no share.
    return { params };
  }
  let source: Source | undefined;
  if (src.startsWith("local:")) source = { kind: "local", name: src.slice(6) };
  else if (src.startsWith("url:")) source = { kind: "url", path: src.slice(4) };
  else if (src.startsWith("gist:")) source = { kind: "api-gist", id: src.slice(5) };
  else if (/^[a-z][a-z0-9-]*:/.test(src)) {
    const at = src.indexOf(":");
    source = { kind: "configured", source: src.slice(0, at), id: src.slice(at + 1) };
  }
  else if (/^[\w-]+\/[0-9a-f]{20,}$/i.test(src)) {
    const [owner, id] = src.split("/") as [string, string];
    source = { kind: "raw-gist", owner, id };
  } else if (GIST_ID.test(src)) source = { kind: "api-gist", id: src };
  return { source, params };
}

/**
 * Read a link someone pasted: a viewer link (its hash names the share, whatever site it is on),
 * a gist page or raw URL, or just the part after `#` (`owner/gistId`, `gist:<id>`, …).
 * A scheme-less `gist.github.com/…` or `localhost:3000/…` counts too. Undefined when it names no share.
 */
export function parseShareLink(input: string): HashState | undefined {
  const text = input.trim();
  if (!text) return undefined;
  let url: URL | undefined;
  try {
    // Without the scheme, `localhost:3000/…` would parse with `localhost:` as its scheme.
    url = new URL(/^([\w-]+(\.[\w-]+)+|localhost)(:\d+)?\//i.test(text) ? `https://${text}` : text);
  } catch {
    // Not a URL: a bare hash.
  }
  if (url && (url.protocol === "https:" || url.protocol === "http:")) {
    if (!GIST_HOSTS.has(url.hostname.toLowerCase())) {
      const parsed = parseHash(url.hash);
      return parsed.source ? parsed : undefined;
    }
    // gist.github.com/<owner>/<id>[/<revision>], gist.github.com/<id>, gist.githubusercontent.com/<owner>/<id>/raw/…
    const [first = "", second = ""] = url.pathname.split("/").filter(Boolean);
    const params = new URLSearchParams();
    if (GIST_OWNER.test(first) && GIST_ID.test(second)) return { source: { kind: "raw-gist", owner: first, id: second }, params };
    if (GIST_ID.test(first) && !second) return { source: { kind: "api-gist", id: first }, params };
    return undefined;
  }
  const parsed = parseHash(text.startsWith("#") ? text : `#${text}`);
  return parsed.source ? parsed : undefined;
}

/** What parseHash would misread, `%` (it decodes) and `&` (it splits), plus `#`, which isn't safe twice in a link. Spaces and `/` stay readable. */
const escapeHead = (s: string) => s.replace(/[%&#]/g, encodeURIComponent);

export function formatHash(state: HashState): string {
  const s = state.source;
  const head = !s
    ? ""
    : s.kind === "raw-gist"
      ? `${s.owner}/${s.id}`
      : s.kind === "api-gist"
        ? `gist:${s.id}`
        : s.kind === "local"
          ? `local:${escapeHead(s.name)}`
          : s.kind === "configured"
            ? `${s.source}:${s.id}`
            : s.kind === "embedded"
              ? ""
              : `url:${escapeHead(s.path)}`;
  const params = state.params.toString();
  return `#${head}${params ? `&${params}` : ""}`;
}

/** The session a single-file export carries, when this page is one. */
export function embeddedSource(doc: Document = document): Source | undefined {
  return doc.getElementById(EMBEDDED_SHARE_ID) ? { kind: "embedded" } : undefined;
}

const FILE = "session.json";

/**
 * Where the viewer actually fetched a share from, shown in the header. For gists the
 * owner is GitHub's word (raw URLs 404 for the wrong owner; the API reports it), but the
 * transcript itself is whatever that owner uploaded.
 */
export interface Provenance {
  label: string;
  href?: string;
}

export interface LoadedShare {
  data: unknown;
  provenance: Provenance;
  /** Length of the share's JSON text (UTF-16 code units, close to bytes for transcripts), for the loading screen. */
  size: number;
}

const gistProvenance = (id: string, owner?: string): Provenance => ({
  label: owner ? `GitHub gist by @${owner}` : "anonymous GitHub gist",
  href: `https://gist.github.com/${owner ? `${encodeURIComponent(owner)}/` : ""}${encodeURIComponent(id)}`,
});

/**
 * Resolve a `#url:` path against the page and require the result to stay on its origin.
 * Checking the resolved URL (not the raw string) matters: the URL parser strips leading
 * whitespace, removes tabs anywhere and treats `\` like `/`, so " https://x", "ht<TAB>tps://x",
 * "/\x" and "\\x" all leave the origin while looking scheme-less.
 */
export function sameOriginUrl(path: string, base: string): string {
  const url = new URL(path, base);
  if (url.origin !== new URL(base).origin) throw new Error("Only same-origin paths are allowed for #url:");
  return url.href;
}

/** `onFetch` is told each URL just before it is requested (an API gist can take two), for the loading screen. */
export async function loadSource(source: Source, base = location.href, onFetch?: (url: URL) => void): Promise<LoadedShare> {
  let url: string;
  let provenance: Provenance;
  switch (source.kind) {
    case "embedded": {
      const text = document.getElementById(EMBEDDED_SHARE_ID)?.textContent;
      if (!text) throw new Error("This page has no session in it.");
      return { data: JSON.parse(text), provenance: { label: "this HTML file" }, size: text.length };
    }
    case "raw-gist":
      url = `https://gist.githubusercontent.com/${encodeURIComponent(source.owner)}/${encodeURIComponent(source.id)}/raw/${FILE}`;
      provenance = gistProvenance(source.id, source.owner);
      break;
    case "local":
      url = `./local/${encodeURIComponent(source.name)}`;
      provenance = { label: `local file ${source.name}` };
      break;
    case "configured": {
      const template = SOURCES[source.source];
      if (!template) throw new Error(`This viewer has no "${source.source}" share source configured (see viewer.config.json).`);
      if (!SHARE_ID.test(source.id)) throw new Error("Invalid share id.");
      url = template.replace("{id}", encodeURIComponent(source.id));
      provenance = { label: `${source.source} share on ${new URL(url).host}` };
      break;
    }
    case "url":
      url = sameOriginUrl(source.path, base);
      provenance = { label: `${new URL(url).pathname} on this site` };
      break;
    case "api-gist": {
      const api = `https://api.github.com/gists/${encodeURIComponent(source.id)}`;
      onFetch?.(new URL(api));
      const res = await fetch(api);
      if (res.status === 404) throw new Error("Share not found. It may have been deleted.");
      if (!res.ok) throw new Error(`GitHub API error ${res.status}${res.status === 403 ? " (rate limited — use the owner/id link form)" : ""}`);
      const gist = (await res.json()) as {
        owner?: { login?: unknown } | null;
        files?: Record<string, { content?: string; truncated?: boolean; raw_url?: string }>;
      };
      const owner = typeof gist.owner?.login === "string" ? gist.owner.login : undefined;
      provenance = gistProvenance(source.id, owner);
      const file = gist.files?.[FILE];
      if (!file) throw new Error(`No ${FILE} in this gist.`);
      if (!file.truncated && file.content) return { data: JSON.parse(file.content), provenance, size: file.content.length };
      if (!file.raw_url) throw new Error("Gist file is truncated and has no raw URL.");
      url = file.raw_url;
      break;
    }
  }
  onFetch?.(new URL(url, base));
  const res = await fetch(url);
  if (res.status === 404) throw new Error("Share not found. It may have been deleted.");
  if (!res.ok) throw new Error(`Failed to load share (${res.status})`);
  const text = await res.text();
  return { data: JSON.parse(text), provenance, size: text.length };
}
