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

/**
 * Serve the viewer at /session/ (mirroring the hosted layout) plus local share
 * files at /session/local/<name>, loadable via `#local:<name>`.
 */
export function startViewerServer(opts: { port: number; files?: string[]; host?: string }): Promise<{ server: Server; url: string; localNames: string[] }> {
  const dist = viewerDistDir();
  if (!existsSync(join(dist, "index.html"))) throw new Error(`Viewer not built at ${dist} — run \`npm run build:viewer\``);
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
      const candidate = normalize(join(dist, path || "index.html"));
      if (candidate.startsWith(dist) && existsSync(candidate) && statSync(candidate).isFile()) file = candidate;
    }
    if (!file) return void res.writeHead(404).end("not found");
    res.writeHead(200, { "Content-Type": MIME[extname(file)] ?? "application/octet-stream", "Cache-Control": "no-store" });
    res.end(readFileSync(file));
  });
  const host = opts.host ?? "0.0.0.0";
  return new Promise((resolvePromise, reject) => {
    server.once("error", (err: NodeJS.ErrnoException) =>
      reject(err.code === "EADDRINUSE" ? new Error(`Port ${opts.port} is already in use — pass --port <n> to pick another`) : err),
    );
    server.listen(opts.port, host, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : opts.port;
      resolvePromise({ server, url: `http://${host === "0.0.0.0" ? "localhost" : host}:${port}/session/`, localNames: [...local.keys()] });
    });
  });
}
