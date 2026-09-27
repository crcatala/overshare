/**
 * Where a share lives, parsed from the URL hash (never sent to the server):
 *   #<owner>/<gistId>     secret gist via raw URL (no API rate limit)  ← what `publish` emits
 *   #gist:<gistId>        gist via the GitHub API (60 req/h/IP unauthenticated)
 *   #<32-hex gistId>      same as gist:
 *   #local:<name>         file served by `agent-share serve` at ./local/<name>
 *   #url:<path>           same-origin path
 *   #<source>:<id>        a source configured at build time in viewer.config.json,
 *                         e.g. #r2:<id> → https://shares.example.com/s/<id>.json
 * Extra `&key=value` params follow the source, e.g. `&view=minimal`.
 */
export type Source =
  | { kind: "raw-gist"; owner: string; id: string }
  | { kind: "api-gist"; id: string }
  | { kind: "local"; name: string }
  | { kind: "url"; path: string }
  | { kind: "configured"; source: string; id: string };

/** Share sources baked in by viewer/build.mjs from viewer.config.json. */
declare const __AGENT_SHARE_SOURCES__: Record<string, string>;
const SOURCES: Record<string, string> = typeof __AGENT_SHARE_SOURCES__ === "undefined" ? {} : __AGENT_SHARE_SOURCES__;
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

export function formatHash(state: HashState): string {
  const s = state.source;
  const head = !s
    ? ""
    : s.kind === "raw-gist"
      ? `${s.owner}/${s.id}`
      : s.kind === "api-gist"
        ? `gist:${s.id}`
        : s.kind === "local"
          ? `local:${s.name}`
          : s.kind === "configured"
            ? `${s.source}:${s.id}`
            : `url:${s.path}`;
  const params = state.params.toString();
  return `#${head}${params ? `&${params}` : ""}`;
}

const FILE = "session.json";

export async function loadSource(source: Source): Promise<unknown> {
  let url: string;
  switch (source.kind) {
    case "raw-gist":
      url = `https://gist.githubusercontent.com/${encodeURIComponent(source.owner)}/${encodeURIComponent(source.id)}/raw/${FILE}`;
      break;
    case "local":
      url = `./local/${encodeURIComponent(source.name)}`;
      break;
    case "configured": {
      const template = SOURCES[source.source];
      if (!template) throw new Error(`This viewer has no "${source.source}" share source configured (see viewer.config.json).`);
      if (!SHARE_ID.test(source.id)) throw new Error("Invalid share id.");
      url = template.replace("{id}", encodeURIComponent(source.id));
      break;
    }
    case "url":
      if (/^[a-z]+:/i.test(source.path) || source.path.startsWith("//")) throw new Error("Only same-origin paths are allowed for #url:");
      url = source.path;
      break;
    case "api-gist": {
      const res = await fetch(`https://api.github.com/gists/${encodeURIComponent(source.id)}`);
      if (res.status === 404) throw new Error("Share not found. It may have been deleted.");
      if (!res.ok) throw new Error(`GitHub API error ${res.status}${res.status === 403 ? " (rate limited — use the owner/id link form)" : ""}`);
      const gist = (await res.json()) as { files?: Record<string, { content?: string; truncated?: boolean; raw_url?: string }> };
      const file = gist.files?.[FILE];
      if (!file) throw new Error(`No ${FILE} in this gist.`);
      if (!file.truncated && file.content) return JSON.parse(file.content);
      if (!file.raw_url) throw new Error("Gist file is truncated and has no raw URL.");
      url = file.raw_url;
      break;
    }
  }
  const res = await fetch(url);
  if (res.status === 404) throw new Error("Share not found. It may have been deleted.");
  if (!res.ok) throw new Error(`Failed to load share (${res.status})`);
  return res.json();
}
