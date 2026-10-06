#!/usr/bin/env node
/**
 * Rasterize site/logo.svg into the landing page's bitmap icons, in site/public/:
 *
 *   favicon.ico           16px and 32px, for browsers that skip the SVG icon (and for /favicon.ico requests)
 *   apple-touch-icon.png  180px, for iOS home screens. iOS rounds the corners itself and paints
 *                         transparency black, so this one is a full-bleed square tile.
 *
 * Run it after changing the logo: `node scripts/favicons.mjs`. It draws the SVG on a canvas in headless
 * Chromium (`$CHROME`, default `chromium`), so the bitmaps match what a browser renders.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const repo = resolve(import.meta.dirname, "..");
const out = join(repo, "site", "public");
const chrome = process.env.CHROME ?? "chromium";

/** PNG bytes of `svg` drawn at each size. */
function raster(svg, sizes) {
  const dir = mkdtempSync(join(tmpdir(), "overshare-favicons-"));
  try {
    const page = join(dir, "raster.html");
    const src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    writeFileSync(
      page,
      `<body><pre id="out"></pre><script>
const img = new Image();
img.onload = () => {
  const pngs = {};
  for (const size of ${JSON.stringify(sizes)}) {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = size;
    const g = canvas.getContext("2d");
    g.imageSmoothingQuality = "high";
    g.drawImage(img, 0, 0, size, size);
    pngs[size] = canvas.toDataURL("image/png");
  }
  document.getElementById("out").textContent = "@@" + JSON.stringify(pngs) + "@@";
};
img.src = ${JSON.stringify(src)};
</script></body>`,
    );
    const dom = execFileSync(chrome, ["--headless", "--disable-gpu", "--no-sandbox", "--virtual-time-budget=3000", "--dump-dom", pathToFileURL(page).href], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const json = /@@(.*)@@/.exec(dom)?.[1];
    if (!json) throw new Error(`${chrome} did not render the logo`);
    return Object.fromEntries(Object.entries(JSON.parse(json)).map(([size, url]) => [size, Buffer.from(url.split(",")[1], "base64")]));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** An ICO holding PNG images (read by every browser, and by Windows since Vista). */
function ico(pngs) {
  const entries = Object.entries(pngs).map(([size, png]) => [Number(size), png]).sort((a, b) => a[0] - b[0]);
  const header = Buffer.alloc(6 + 16 * entries.length);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);
  let offset = header.length;
  entries.forEach(([size, png], i) => {
    const at = 6 + 16 * i;
    header.writeUInt8(size % 256, at);
    header.writeUInt8(size % 256, at + 1);
    header.writeUInt16LE(1, at + 4);
    header.writeUInt16LE(32, at + 6);
    header.writeUInt32LE(png.length, at + 8);
    header.writeUInt32LE(offset, at + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...entries.map(([, png]) => png)]);
}

const logo = readFileSync(join(repo, "site", "logo.svg"), "utf8");
const tile = /(<rect\b[^>]*?) rx="[\d.]+"/;
if (!tile.test(logo)) throw new Error("site/logo.svg: no rounded tile <rect rx> to square off for the touch icon");

writeFileSync(join(out, "favicon.ico"), ico(raster(logo, [16, 32])));
writeFileSync(join(out, "apple-touch-icon.png"), raster(logo.replace(tile, "$1"), [180])[180]);
console.log(`wrote ${join("site", "public", "favicon.ico")} and ${join("site", "public", "apple-touch-icon.png")}`);
