/** Build-time viewer config: validated share sources and the CSP derived from them. */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const RESERVED = new Set(["gist", "local", "url"]);
const GIST_ORIGINS = ["https://api.github.com", "https://gist.githubusercontent.com"];

export function loadViewerConfig(path = process.env.AGENT_SHARE_VIEWER_CONFIG ?? join(root, "viewer.config.json")) {
  const config = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  const sources = config.sources ?? {};
  for (const [name, template] of Object.entries(sources)) {
    if (!/^[a-z][a-z0-9-]*$/.test(name) || RESERVED.has(name)) throw new Error(`viewer config: invalid source name "${name}"`);
    if (typeof template !== "string" || !template.includes("{id}")) throw new Error(`viewer config: source "${name}" must be a URL template containing {id}`);
    const url = new URL(template.replace("{id}", "x"));
    if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
      throw new Error(`viewer config: source "${name}" must use https`);
    }
  }
  return { sources };
}

export function contentSecurityPolicy(sources, { header = false } = {}) {
  const origins = [...new Set([...GIST_ORIGINS, ...Object.values(sources).map((t) => new URL(t.replace("{id}", "x")).origin)])];
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    `connect-src 'self' ${origins.join(" ")}`,
    "base-uri 'none'",
    "form-action 'none'",
    // frame-ancestors is ignored in <meta>, so it only goes in the header.
    ...(header ? ["frame-ancestors 'none'"] : []),
  ].join("; ");
}
