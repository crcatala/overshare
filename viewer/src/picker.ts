/**
 * The local sessions page: what `overshare serve` (or the dev server) offers when the
 * viewer is opened without a share in the link. Each row is a link plus small labels for
 * what the share is.
 */
import { plural } from "../../src/format.ts";
import { harnessLabel } from "../../src/harnesses/meta.ts";
import { attribution } from "./attribution.ts";
import { h } from "./dom.ts";
import { formatDate, iconButton } from "./header.ts";
import { settingsButton, type SettingsOptions } from "./settings.ts";

export interface LocalShare {
  name: string;
  title?: string;
  harness?: string;
  mode?: string;
  turns?: number;
  project?: string;
  startedAt?: string;
  error?: string;
}

/** `./local/index.json`, or undefined when there's nothing to pick (a deployed viewer 404s). */
export async function fetchLocalShares(): Promise<LocalShare[] | undefined> {
  try {
    const res = await fetch("./local/index.json", { cache: "no-store" });
    if (!res.ok) return undefined;
    const shares = (await res.json()) as unknown;
    return Array.isArray(shares) && shares.length > 0 ? (shares as LocalShare[]) : undefined;
  } catch {
    return undefined;
  }
}

/** A row's details as small labels in the variant's palette, after the file name. */
function meta(s: LocalShare): HTMLElement {
  const badge = (text: string, cls = "", attrs: Record<string, string> = {}) => h("span", { class: `badge ${cls}`.trim(), ...attrs }, text);
  const started = formatDate(s.startedAt);
  return h(
    "div",
    { class: "picker-meta" },
    h("span", { class: "picker-file" }, s.name),
    s.error ? badge("unreadable", "is-error", { title: s.error }) : null,
    s.harness ? badge(harnessLabel(s.harness), "badge-harness") : null,
    s.mode ? badge(s.mode, "badge-mode", { "data-mode": s.mode }) : null,
    s.turns !== undefined ? badge(plural(s.turns, "turn")) : null,
    s.project ? badge(s.project, "badge-project") : null,
    started ? h("span", { class: "picker-date" }, started) : null,
  );
}

export interface PickerOptions {
  settings: SettingsOptions;
  toggleTheme: () => void;
}

export function renderPicker(shares: LocalShare[], opts: PickerOptions): HTMLElement {
  return h(
    "div",
    { class: "page picker" },
    h(
      "header",
      { class: "hdr" },
      h("div", { class: "hdr-top" }, h("h1", { class: "hdr-title" }, "Local sessions"), h("div", { class: "hdr-actions" }, iconButton("Toggle color theme", "", opts.toggleTheme, "theme"), settingsButton(opts.settings))),
      h("p", { class: "fine" }, `Served by overshare serve · ${plural(shares.length, "file")}`),
    ),
    h(
      "ul",
      { class: "picker-list" },
      ...shares.map((s) => h("li", {}, h("a", { href: `#local:${encodeURIComponent(s.name)}` }, s.title ?? s.name), meta(s))),
    ),
    attribution(),
  );
}

