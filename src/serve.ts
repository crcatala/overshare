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
  const local = new Map<string, string>();
  for (const f of opts.files ?? []) local.set(basename(f), resolve(f));

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    let path = decodeURIComponent(url.pathname);
    if (path === "/" || path === "/session") {
      res.writeHead(302, { Location: "/session/" }).end();
      return;
    }
    if (!path.startsWith("/session/")) return void res.writeHead(404).end("not found");
    path = path.slice("/session/".length);
    let file: string | undefined;
    if (path.startsWith("local/")) {
      file = local.get(path.slice("local/".length));
    } else {
      const viewerDir = join(dist, "session");
      const candidate = normalize(join(viewerDir, path || "index.html"));
      if (candidate.startsWith(viewerDir) && existsSync(candidate) && statSync(candidate).isFile()) file = candidate;
    }
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
      return { server, port, url: `http://${host === "0.0.0.0" ? "localhost" : host}:${port}/session/`, localNames: [...local.keys()] };
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
