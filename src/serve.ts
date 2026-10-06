import { createServer, type Server } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { isIP } from "node:net";
import { basename, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".map": "application/json",
};

export function viewerDistDir(): string {
  // dist/serve.js and src/serve.ts both sit one level below the package root.
  return fileURLToPath(new URL("../viewer/dist/", import.meta.url));
}

/**
 * Loopback only by default: the server hands out share files to anyone who can reach
 * it. `--host 0.0.0.0` opts in to exposing it on the network.
 */
export const DEFAULT_HOST = "127.0.0.1";

/** How many successive ports to try when the requested one is taken. */
export const PORT_ATTEMPTS = 20;

export interface ServeOptions {
  port: number;
  files?: string[];
  host?: string;
  /** Fail instead of trying port+1, port+2, … when the port is in use. */
  strictPort?: boolean;
  /** Extra host names the server answers to (see `hostAllowed`), e.g. a Tailscale or LAN name. */
  allowedHosts?: string[];
}

/** A Host header's name, lowercased, without port, brackets or trailing dot; undefined if it doesn't parse. */
function hostName(header: string): string | undefined {
  try {
    return new URL(`http://${header}`).hostname.replace(/^\[(.*)\]$/, "$1").replace(/\.$/, "").toLowerCase();
  } catch {
    return undefined;
  }
}

/**
 * Whether to answer a request with this Host header. Without the check a web page could point its own
 * domain at 127.0.0.1 (DNS rebinding) and read the served shares as same-origin; such a request still
 * names the page's domain. As in Vite: IP addresses, localhost and *.localhost always pass (rebinding
 * needs a domain name), and other names only when listed in `allowed`. No Host at all is not a browser.
 */
export function hostAllowed(header: string | undefined, allowed: Iterable<string> = []): boolean {
  if (header === undefined) return true;
  const name = hostName(header);
  if (!name) return false;
  if (isIP(name) || name === "localhost" || name.endsWith(".localhost")) return true;
  for (const a of allowed) if (hostName(a) === name) return true;
  return false;
}

/**
 * Serve the viewer at /s/ (mirroring the hosted layout) plus local share
 * files at /s/local/<name>, loadable via `#local:<name>`. If the port is in
 * use, the next ports are tried (like Vite) unless `strictPort` is set.
 */
export async function startViewerServer(
  opts: ServeOptions,
): Promise<{ server: Server; url: string; port: number; localNames: string[] }> {
  const dist = viewerDistDir();
  if (!existsSync(join(dist, "s", "index.html"))) throw new Error(`Viewer not built at ${dist} — run \`npm run build:viewer\``);
  const local = localShares(opts.files ?? []);
  const host = opts.host ?? DEFAULT_HOST;
  const allowedHosts = [host, ...(opts.allowedHosts ?? [])];

  const server = createServer((req, res) => {
    if (!hostAllowed(req.headers.host, allowedHosts)) {
      return void res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" }).end("This host name is not allowed; pass it to --allowed-host.\n");
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    let path: string;
    try {
      path = decodeURIComponent(url.pathname);
    } catch {
      return void res.writeHead(400).end("bad request");
    }
    if (path === "/" || path === "/s") {
      res.writeHead(302, { Location: "/s/" }).end();
      return;
    }
    if (!path.startsWith("/s/")) return void res.writeHead(404).end("not found");
    path = path.slice("/s/".length);
    if (path.startsWith("local/")) {
      const body = local.respond(path.slice("local/".length));
      if (!body) return void res.writeHead(404).end("not found");
      res.writeHead(200, { "Content-Type": MIME[".json"]!, "Cache-Control": "no-store" });
      return void res.end(body);
    }
    const viewerDir = join(dist, "s");
    const candidate = normalize(join(viewerDir, path || "index.html"));
    // With the separator, so ../s-other (or ../standalone.html) can't pass as a prefix of dist/s.
    const file = candidate.startsWith(viewerDir + sep) && existsSync(candidate) && statSync(candidate).isFile() ? candidate : undefined;
    if (!file) return void res.writeHead(404).end("not found");
    res.writeHead(200, { "Content-Type": MIME[extname(file)] ?? "application/octet-stream", "Cache-Control": "no-store" });
    res.end(readFileSync(file));
  });

  const attempts = opts.strictPort ? 1 : PORT_ATTEMPTS;
  for (let i = 0; i < attempts; i++) {
    const candidate = opts.port + i;
    try {
      const port = await listen(server, candidate, host);
      return { server, port, url: `http://${host === "0.0.0.0" ? "localhost" : host}:${port}/s/`, localNames: local.names };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EADDRINUSE") throw err;
    }
  }
  throw new Error(
    opts.strictPort
      ? `Port ${opts.port} is already in use — pass --port <n> to pick another`
      : `Ports ${opts.port}–${opts.port + attempts - 1} are all in use — pass --port <n> to pick another`,
  );
}

function listen(server: Server, port: number, host: string): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const onError = (err: Error) => {
      server.off("listening", onListening);
      reject(err);
    };
    const onListening = () => {
      server.off("error", onError);
      const address = server.address();
      resolvePromise(typeof address === "object" && address ? address.port : port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

export interface LocalShareSummary {
  name: string;
  title?: string;
  harness?: string;
  mode?: string;
  turns?: number;
  /** "name" or "name @ branch". */
  project?: string;
  startedAt?: string;
  error?: string;
}

/**
 * Share files exposed under `local/`: `local/<name>` returns the file, and
 * `local/index.json` lists them so the viewer can show a picker when opened without
 * a share in the hash. Shared by `overshare serve` and the Vite dev server.
 */
export function localShares(files: string[]): { names: string[]; respond(name: string): Buffer | string | undefined } {
  const byName = new Map<string, string>();
  for (const f of files) byName.set(basename(f), resolve(f));
  return {
    names: [...byName.keys()],
    /** `name` is the already-decoded path segment after `local/`. */
    respond(name: string) {
      if (name === "index.json" && !byName.has("index.json")) return JSON.stringify(summarize(byName));
      const file = byName.get(name);
      return file && existsSync(file) ? readFileSync(file) : undefined;
    },
  };
}

function summarize(byName: Map<string, string>): LocalShareSummary[] {
  return [...byName].map(([name, file]) => {
    try {
      const s = JSON.parse(readFileSync(file, "utf8")) as {
        title?: string;
        harness?: { name?: string };
        mode?: string;
        stats?: { turns?: number };
        project?: { name?: string; branch?: string };
        startedAt?: string;
      };
      const project = s.project?.name ? `${s.project.name}${s.project.branch ? ` @ ${s.project.branch}` : ""}` : undefined;
      return { name, title: s.title, harness: s.harness?.name, mode: s.mode, turns: s.stats?.turns, project, startedAt: s.startedAt };
    } catch (err) {
      return { name, error: (err as Error).message };
    }
  });
}
