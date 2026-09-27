import { createServer, type Server } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join, normalize, resolve } from "node:path";
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

/** How many successive ports to try when the requested one is taken. */
export const PORT_ATTEMPTS = 20;

export interface ServeOptions {
  port: number;
  files?: string[];
  host?: string;
  /** Fail instead of trying port+1, port+2, … when the port is in use. */
  strictPort?: boolean;
}

/**
 * Serve the viewer at /session/ (mirroring the hosted layout) plus local share
 * files at /session/local/<name>, loadable via `#local:<name>`. If the port is in
 * use, the next ports are tried (like Vite) unless `strictPort` is set.
 */
export async function startViewerServer(
  opts: ServeOptions,
): Promise<{ server: Server; url: string; port: number; localNames: string[] }> {
  const dist = viewerDistDir();
  if (!existsSync(join(dist, "session", "index.html"))) throw new Error(`Viewer not built at ${dist} — run \`npm run build:viewer\``);
  const local = localShares(opts.files ?? []);

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    let path: string;
    try {
      path = decodeURIComponent(url.pathname);
    } catch {
      return void res.writeHead(400).end("bad request");
    }
    if (path === "/" || path === "/session") {
      res.writeHead(302, { Location: "/session/" }).end();
      return;
    }
    if (!path.startsWith("/session/")) return void res.writeHead(404).end("not found");
    path = path.slice("/session/".length);
    if (path.startsWith("local/")) {
      const body = local.respond(path.slice("local/".length));
      if (!body) return void res.writeHead(404).end("not found");
      res.writeHead(200, { "Content-Type": MIME[".json"]!, "Cache-Control": "no-store" });
      return void res.end(body);
    }
    const viewerDir = join(dist, "session");
    const candidate = normalize(join(viewerDir, path || "index.html"));
    const file = candidate.startsWith(viewerDir) && existsSync(candidate) && statSync(candidate).isFile() ? candidate : undefined;
    if (!file) return void res.writeHead(404).end("not found");
    res.writeHead(200, { "Content-Type": MIME[extname(file)] ?? "application/octet-stream", "Cache-Control": "no-store" });
    res.end(readFileSync(file));
  });

  const host = opts.host ?? "0.0.0.0";
  const attempts = opts.strictPort ? 1 : PORT_ATTEMPTS;
  for (let i = 0; i < attempts; i++) {
    const candidate = opts.port + i;
    try {
      const port = await listen(server, candidate, host);
      return { server, port, url: `http://${host === "0.0.0.0" ? "localhost" : host}:${port}/session/`, localNames: local.names };
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
  error?: string;
}

/**
 * Share files exposed under `local/`: `local/<name>` returns the file, and
 * `local/index.json` lists them so the viewer can show a picker when opened without
 * a share in the hash. Shared by `agent-share serve` and the Vite dev server.
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
      const s = JSON.parse(readFileSync(file, "utf8")) as { title?: string; harness?: { name?: string }; mode?: string; stats?: { turns?: number } };
      return { name, title: s.title, harness: s.harness?.name, mode: s.mode, turns: s.stats?.turns };
    } catch (err) {
      return { name, error: (err as Error).message };
    }
  });
}
