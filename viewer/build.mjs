/**
 * Builds the static viewer into viewer/dist/:
 *
 *   dist/session/index.html, app.js, app.css   the viewer, served at /session/
 *   dist/_headers, dist/_redirects              Cloudflare (Workers assets / Pages) headers + "/" redirect
 *   dist/robots.txt                             keep shares out of search engines
 *
 * Build-time config (`viewer.config.json`, or the file in $AGENT_SHARE_VIEWER_CONFIG)
 * declares extra share sources such as a public R2 bucket. Their origins are added to
 * the Content-Security-Policy, so a viewer only ever loads data from hosts its
 * deployer chose.
 */
import { build } from "esbuild";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { contentSecurityPolicy, loadViewerConfig } from "./config.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "dist");
const sessionDir = join(out, "session");

const { sources } = loadViewerConfig();
rmSync(out, { recursive: true, force: true });
mkdirSync(sessionDir, { recursive: true });

await build({
  entryPoints: [join(here, "src", "main.ts")],
  bundle: true,
  format: "esm",
  target: "es2022",
  minify: true,
  sourcemap: true,
  outfile: join(sessionDir, "app.js"),
  legalComments: "none",
  define: { __AGENT_SHARE_SOURCES__: JSON.stringify(sources) },
});
writeFileSync(join(sessionDir, "index.html"), readFileSync(join(here, "index.html"), "utf8").replace("{{CSP}}", contentSecurityPolicy(sources)));
copyFileSync(join(here, "src", "styles.css"), join(sessionDir, "app.css"));
writeFileSync(
  join(out, "_headers"),
  [
    "/*",
    "  X-Robots-Tag: noindex, nofollow",
    "  Referrer-Policy: no-referrer",
    "  X-Content-Type-Options: nosniff",
    `  Content-Security-Policy: ${contentSecurityPolicy(sources, { header: true })}`,
    "",
  ].join("\n"),
);
writeFileSync(join(out, "_redirects"), "/ /session/ 302\n");
writeFileSync(join(out, "robots.txt"), "User-agent: *\nDisallow: /\n");

const names = Object.keys(sources);
console.log(`viewer built → ${out}${names.length ? ` (sources: ${names.join(", ")})` : ""}`);
