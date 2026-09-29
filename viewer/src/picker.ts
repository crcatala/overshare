/**
 * The local sessions page: what `agent-share serve` (or the dev server) offers when the
 * viewer is opened without a share in the link. Each row is a link plus small labels for
 * what the share is.
 */
import { plural } from "../../src/format.ts";
import { attribution } from "./attribution.ts";
import { h } from "./dom.ts";
import { formatDate, HARNESS_LABEL, iconButton } from "./header.ts";
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
    s.harness ? badge(HARNESS_LABEL[s.harness] ?? s.harness, "badge-harness") : null,
    s.mode ? badge(s.mode, "badge-mode", { "data-mode": s.mode }) : null,
    s.turns !== undefined ? badge(plural(s.turns, "turn")) : null,
    s.project ? badge(s.project, "badge-project") : null,
    started ? h("span", { class: "picker-date" }, started) : null,
  );
}

const hrefFor = (name: string, variant: string | null | undefined) => `#local:${encodeURIComponent(name)}${variant ? `&variant=${encodeURIComponent(variant)}` : ""}`;

export interface PickerOptions {
  /** The variant named in the link, carried on to the session links. */
  variant: string | null;
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
      h("p", { class: "fine" }, `Served by agent-share serve · ${plural(shares.length, "file")}`),
    ),
    h(
      "ul",
      { class: "picker-list" },
      ...shares.map((s) => h("li", {}, h("a", { href: hrefFor(s.name, opts.variant), "data-share": s.name }, s.title ?? s.name), meta(s))),
    ),
    attribution(),
  );
}

/**
 * Point the session links at another variant, in place. A variant change only restyles the
 * page, so nothing is rebuilt and keyboard focus stays where it is. False when the picker
 * isn't the page showing.
 */
export function setPickerVariant(root: ParentNode, variant: string): boolean {
  const links = root.querySelectorAll<HTMLAnchorElement>(".picker a[data-share]");
  for (const a of links) a.setAttribute("href", hrefFor(a.dataset.share!, variant));
  return links.length > 0;
}
