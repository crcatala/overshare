/**
 * Where a share lives, parsed from the URL hash (never sent to the server):
 *   #<owner>/<gistId>     secret gist via raw URL (no API rate limit)  ← what `publish` emits
 *   #gist:<gistId>        gist via the GitHub API (60 req/h/IP unauthenticated)
 *   #<32-hex gistId>      same as gist:
 *   #local:<name>         file served by `overshare serve` at ./local/<name>
 *   #url:<path>           same-origin path
 *   #<source>:<id>        a source configured at build time in viewer.config.json,
 *                         e.g. #r2:<id> → https://shares.example.com/s/<id>.json
 * Extra `&key=value` params follow the source, e.g. `&turn=3`. Local names and `url:`
 * paths are written with `%`, `&` and `#` escaped, so they read back whole.
 */
export type Source =
  | { kind: "raw-gist"; owner: string; id: string }
  | { kind: "api-gist"; id: string }
  | { kind: "local"; name: string }
  | { kind: "url"; path: string }
  | { kind: "configured"; source: string; id: string };

/** Share sources baked in by vite.config.ts from viewer.config.json. */
declare const __OVERSHARE_SOURCES__: Record<string, string>;
const SOURCES: Record<string, string> = typeof __OVERSHARE_SOURCES__ === "undefined" ? {} : __OVERSHARE_SOURCES__;
const SHARE_ID = /^[A-Za-z0-9_-]{8,128}$/;

export interface HashState {
  source?: Source;
  params: URLSearchParams;
}

export function parseHash(hash: string): HashState {
  const raw = hash.replace(/^#/, "");
  const [head = "", ...rest] = raw.split("&");
  const params = new URLSearchParams(rest.join("&"));
  const src = decodeURIComponent(head);
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
  } else if (/^[0-9a-f]{20,}$/i.test(src)) source = { kind: "api-gist", id: src };
  return { source, params };
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
            : `url:${escapeHead(s.path)}`;
  const params = state.params.toString();
  return `#${head}${params ? `&${params}` : ""}`;
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

export async function loadSource(source: Source, base = location.href): Promise<LoadedShare> {
  let url: string;
  let provenance: Provenance;
  switch (source.kind) {
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
      const res = await fetch(`https://api.github.com/gists/${encodeURIComponent(source.id)}`);
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
      if (!file.truncated && file.content) return { data: JSON.parse(file.content), provenance };
      if (!file.raw_url) throw new Error("Gist file is truncated and has no raw URL.");
      url = file.raw_url;
      break;
    }
  }
  const res = await fetch(url);
  if (res.status === 404) throw new Error("Share not found. It may have been deleted.");
  if (!res.ok) throw new Error(`Failed to load share (${res.status})`);
  return { data: await res.json(), provenance };
}
