/**
 * Landing page (site/) dev server + production build.
 *
 *   npm run dev:site     Vite dev server for the landing page at http://localhost:3001/.
 *                        Its "see an example" links point at the viewer under /s/, which
 *                        this server doesn't serve; `npm run preview:cf` serves both.
 *   npm run build:site   viewer/dist/index.html and viewer/dist/assets/, next to the viewer
 *                        in viewer/dist/s/. Run it after build:viewer: it rewrites _headers,
 *                        _redirects and robots.txt for a deployment with a landing page
 *                        (`/` is the page, only /s/ stays out of search engines).
 *
 * The viewer build alone (what the npm package ships) never includes the landing page.
 */
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";
// @ts-expect-error — plain ESM helper without type declarations (shared with tests)
import { deployFiles, loadViewerConfig, siteContentSecurityPolicy } from "./viewer/config.mjs";

const repo = import.meta.dirname;
const siteRoot = resolve(repo, "site");
const dist = resolve(repo, "viewer", "dist");

export default defineConfig(({ command }) => {
  const dev = command === "serve";
  return {
    root: siteRoot,
    base: "/",
    publicDir: false,
    server: {
      port: 3001,
      fs: { strict: true, allow: [siteRoot, resolve(repo, "viewer/src/fonts"), resolve(repo, "node_modules/@fontsource-variable/bricolage-grotesque")] },
    },
    // Into the viewer's dist (not emptied: the viewer lives in s/), so one deploy serves both.
    build: { outDir: dist, emptyOutDir: false, sourcemap: false, target: "es2022", assetsInlineLimit: 0 },
    plugins: [sitePlugin(dev)],
  };
});

function sitePlugin(dev: boolean): Plugin {
  let write = true;
  return {
    name: "overshare:site",
    transformIndexHtml: (html) => html.replace("{{CSP}}", siteContentSecurityPolicy({ dev })),
    configResolved(config) {
      write = config.build.write;
    },
    buildStart() {
      // A previous site build's hashed files would otherwise pile up next to the new ones.
      if (write && !dev && existsSync(join(dist, "assets"))) rmSync(join(dist, "assets"), { recursive: true });
    },
    closeBundle() {
      // In-memory builds (tests) must not touch viewer/dist.
      if (!write || dev) return;
      if (!existsSync(join(dist, "s", "index.html"))) throw new Error("build the viewer first (npm run build:viewer): the landing page is deployed next to it");
      const { sources } = loadViewerConfig() as { sources: Record<string, string> };
      for (const [name, content] of Object.entries(deployFiles(sources, { site: true }) as Record<string, string>)) {
        writeFileSync(join(dist, name), content);
      }
    },
  };
}
