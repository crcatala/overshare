import { build } from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "dist");
mkdirSync(out, { recursive: true });

await build({
  entryPoints: [join(here, "src", "main.ts")],
  bundle: true,
  format: "esm",
  target: "es2022",
  minify: true,
  sourcemap: true,
  outfile: join(out, "app.js"),
  legalComments: "none",
});
copyFileSync(join(here, "index.html"), join(out, "index.html"));
copyFileSync(join(here, "src", "styles.css"), join(out, "app.css"));
console.log(`viewer built → ${out}`);
