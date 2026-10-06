/**
 * License texts for the fonts the viewer and the landing page bundle. All are under the SIL Open
 * Font License 1.1, which allows redistribution only with each font's copyright notice and the
 * license itself. The font files carry their copyright line but not the license, so every build
 * ships these texts beside them: a file next to each deployed page and a comment inside every
 * single-file HTML export.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Each font's license file, verbatim (copyright notice, any Reserved Font Name, the OFL text). */
const LICENSE_FILES = {
  "JetBrains Mono": "viewer/src/fonts/JetBrainsMono-OFL.txt",
  "Bricolage Grotesque": "node_modules/@fontsource-variable/bricolage-grotesque/LICENSE",
};

export const VIEWER_FONTS = ["JetBrains Mono"];
export const SITE_FONTS = ["JetBrains Mono", "Bricolage Grotesque"];
export const FONT_LICENSES_FILE = "font-licenses.txt";

export function fontLicenses(fonts) {
  const sections = fonts.map((font) => `== ${font} ==\n\n${readFileSync(resolve(root, LICENSE_FILES[font]), "utf8").trim()}\n`);
  return `Fonts bundled with this page: ${fonts.join(", ")}.\nEach is licensed under the SIL Open Font License, Version 1.1; its copyright notice and license follow.\n\n${sections.join("\n")}`;
}

/** The same text as an HTML comment, for pages that carry their fonts inline. */
export function fontLicensesComment(fonts) {
  const text = fontLicenses(fonts);
  if (/<!--|--!?>/.test(text)) throw new Error("font license text cannot be put in an HTML comment");
  return `<!--\n${text}-->`;
}
