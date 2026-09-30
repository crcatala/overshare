/**
 * Viewer dev server + production build.
 *
 *   npm run dev          Vite dev server at /session/ with HMR (CSS hot-swaps; TS edits
 *                        reload the page, which keeps the session since it lives in the
 *                        URL hash). Local shares are served at /session/local/ — the
 *                        fixture sessions by default (generated on first run and
 *                        whenever the saved ones are from an older schema), or the
 *                        files in $AGENT_SHARE_DEV_SHARES.
 *   npm run build:viewer viewer/dist/session/ (relative asset URLs, so any base path
 *                        works) plus _headers, _redirects and robots.txt in viewer/dist/.
 *
 * `viewer.config.json` (or $AGENT_SHARE_VIEWER_CONFIG) adds share sources; their
 * origins go into the Content-Security-Policy.
 */
import { readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";
import { loadConfig } from "./src/config.ts";
import { exportFixtureShares, generateFixtures } from "./src/fixtures/index.ts";
import { localShares } from "./src/serve.ts";
// @ts-expect-error — plain ESM helper without type declarations (shared with tests)
import { contentSecurityPolicy, deployFiles, loadViewerConfig } from "./viewer/config.mjs";

const repo = import.meta.dirname;
const viewerRoot = resolve(repo, "viewer");

export default defineConfig(({ command }) => {
  const dev = command === "serve";
  const { sources } = loadViewerConfig() as { sources: Record<string, string> };
  return {
    root: viewerRoot,
    base: dev ? "/session/" : "./",
    publicDir: false,
    define: { __AGENT_SHARE_SOURCES__: JSON.stringify(sources) },
    // Listens on localhost only unless you pass `npm run dev -- --host`. Any Host header is
    // accepted (e.g. a VPS domain, Tailscale name or tunnel), which disables Vite's
    // DNS-rebinding protection. To keep that safe, Vite may only read the viewer and the
    // shared src/ modules: without fs.allow it would serve any file in the checkout via
    // /@fs/ (raw fixture transcripts, a secrets file kept here, …). Local shares are served
    // separately by the plugin below, and only the files it was given. The one package
    // allowed is the bundled prose font (the build inlines it as a hashed asset).
    server: {
      port: 3000,
      allowedHosts: true,
      fs: { strict: true, allow: [viewerRoot, resolve(repo, "src"), resolve(repo, "node_modules/@fontsource-variable/ibm-plex-sans")] },
    },
    build: { outDir: "dist/session", emptyOutDir: true, sourcemap: true, target: "es2022" },
    plugins: [cspPlugin(sources, dev), deployFilesPlugin(sources), localSharesPlugin()],
  };
});

function cspPlugin(sources: Record<string, string>, dev: boolean): Plugin {
  return {
    name: "agent-share:csp",
    transformIndexHtml: (html) => html.replace("{{CSP}}", contentSecurityPolicy(sources, { dev })),
  };
}

function deployFilesPlugin(sources: Record<string, string>): Plugin {
  let write = true;
  return {
    name: "agent-share:deploy-files",
    apply: "build",
    configResolved(config) {
      write = config.build.write;
    },
    closeBundle() {
      // In-memory builds (tests) must not touch viewer/dist.
      if (!write) return;
      for (const [name, content] of Object.entries(deployFiles(sources) as Record<string, string>)) {
        writeFileSync(join(viewerRoot, "dist", name), content);
      }
    },
  };
}

/** Serve share JSON at /session/local/ during development, like `agent-share serve`. */
function localSharesPlugin(): Plugin {
  return {
    name: "agent-share:local-shares",
    apply: "serve",
    configureServer(server) {
      const files = devShareFiles((msg) => server.config.logger.info(msg));
      const local = localShares(files);
      server.middlewares.use((req, res, next) => {
        const path = (req.url ?? "/").split("?")[0]!;
        if (path === "/" || path === "/session") {
          res.writeHead(302, { Location: "/session/" }).end();
          return;
        }
        if (!path.startsWith("/session/local/")) return next();
        let name: string;
        try {
          name = decodeURIComponent(path.slice("/session/local/".length));
        } catch {
          return void res.writeHead(400).end("bad request");
        }
        const body = local.respond(name);
        if (!body) return void res.writeHead(404).end("not found");
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }).end(body);
      });
      server.config.logger.info(`  agent-share: ${files.length} local shares at /session/ (picker) — ${files.length ? "e.g. #local:" + files[0]!.split("/").at(-1) : "none"}`);
    },
  };
}

function devShareFiles(log: (msg: string) => void): string[] {
  const fromEnv = process.env.AGENT_SHARE_DEV_SHARES?.split(/[,\s]+/).filter(Boolean);
  if (fromEnv?.length) return fromEnv.map((f) => resolve(f));
  const outDir = join(repo, "fixtures-out");
  const sharesDir = join(outDir, "shares");
  // Generated from code and deterministic, so regenerate every time rather than keep shares that may predate a schema change.
  log("  agent-share: generating fixture sessions in fixtures-out/ …");
  exportFixtureShares(generateFixtures({ outDir }), outDir, loadConfig());
  return readdirSync(sharesDir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => join(sharesDir, f));
}
