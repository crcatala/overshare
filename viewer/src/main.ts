import "./styles/fonts.css";
import "./styles/base.css";
import "./styles/classic.css";
import "./styles/cli.css";
import "./styles/timeline.css";
import "./styles/hybrid.css";
import "./styles/log.css";
import { plural } from "../../src/format.ts";
import { availableModes, projectSession } from "../../src/modes.ts";
import { SCHEMA_VERSION, type NormalizedSession, type ShareMode } from "../../src/schema.ts";
import { relayoutTables, releaseTables, setTableStyle } from "./asciitable.ts";
import { h, hideTooltip } from "./dom.ts";
import { HARNESS_LABEL, renderHeader, renderMinibar, type Controls } from "./header.ts";
import { load, save } from "./prefs.ts";
import { closeMenus, settingsButton, type SettingsOptions } from "./settings.ts";
import { formatHash, loadSource, parseHash, type HashState, type Provenance } from "./source.ts";
import { renderToc } from "./toc.ts";
import { renderTokenRail } from "./tokens.ts";
import { renderTranscript, type TurnInfo } from "./transcript.ts";
import { DEFAULT_VARIANT, findVariant, VARIANTS, type Variant } from "./variants.ts";

const app = document.getElementById("app") as HTMLElement;
const root = document.documentElement;

let shared: NormalizedSession | undefined;
let provenance: Provenance | undefined;
let state: HashState = parseHash(location.hash);
/** Listeners and observers of the current render, dropped on the next one. */
let teardown = new AbortController();

// ---------- theme & variant ----------
function applyTheme(theme: string | null): void {
  if (theme === "light" || theme === "dark") root.dataset.theme = theme;
  else delete root.dataset.theme;
}
applyTheme(load("theme"));

function toggleTheme(): void {
  const dark = root.dataset.theme ? root.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  const next = dark ? "light" : "dark";
  applyTheme(next);
  save("theme", next);
}

function currentVariant(): Variant {
  return findVariant(state.params.get("variant")) ?? findVariant(load("variant")) ?? findVariant(DEFAULT_VARIANT)!;
}

function applyVariant(v: Variant): void {
  root.dataset.variant = v.id;
  setTableStyle(v.table);
}
applyVariant(currentVariant());

function setVariant(v: Variant): void {
  save("variant", v.id);
  state.params.set("variant", v.id);
  history.replaceState(null, "", formatHash(state));
  // render() applies the variant itself, after noting where the reader is.
  if (shared) render({ keepPlace: true });
  else {
    applyVariant(v);
    void main();
  }
}

const settings: SettingsOptions = { current: currentVariant, onPick: setVariant };

// ---------- rails ----------
type Side = "left" | "right";
const railOpen: Record<Side, boolean> = { left: load("rail-left") !== "closed", right: load("rail-right") !== "closed" };
/** In overlay mode (narrow windows) rails start closed and aren't remembered. */
const overlayOpen: Record<Side, boolean> = { left: false, right: false };

function cssPx(name: string): number {
  return parseFloat(getComputedStyle(root).getPropertyValue(name)) || 0;
}

function docked(): boolean {
  return root.dataset.dock === "docked";
}

function updateDock(): void {
  // Rails float beside the centered transcript only when both fit without covering it.
  const need = cssPx("--content-w") + 2 * (cssPx("--rail-w") + cssPx("--rail-gap")) + 24;
  root.dataset.dock = window.innerWidth >= need ? "docked" : "overlay";
  syncRails();
}

function syncRails(): void {
  const open = docked() ? railOpen : overlayOpen;
  root.dataset.left = open.left ? "open" : "closed";
  root.dataset.right = open.right ? "open" : "closed";
  for (const side of ["left", "right"] as Side[]) {
    document.querySelector(`.rail-${side}`)?.toggleAttribute("inert", !open[side]);
  }
}

function toggleRail(side: Side, force?: boolean): void {
  if (docked()) {
    railOpen[side] = force ?? !railOpen[side];
    save(`rail-${side}`, railOpen[side] ? null : "closed");
  } else {
    const next = force ?? !overlayOpen[side];
    overlayOpen.left = false;
    overlayOpen.right = false;
    overlayOpen[side] = next;
  }
  syncRails();
}

function rail(side: Side, title: string, glyph: string, body: HTMLElement): HTMLElement[] {
  const panel = h(
    "aside",
    { class: `rail rail-${side}`, "aria-label": title },
    h(
      "div",
      { class: "rail-head" },
      h("h2", {}, title),
      h("button", { type: "button", class: "icon rail-x", "aria-label": `Hide ${title.toLowerCase()}`, title: `Hide ${title.toLowerCase()} (${side === "left" ? "[" : "]"})`, onclick: () => toggleRail(side, false) }, side === "left" ? "«" : "»"),
    ),
    h("div", { class: "rail-body" }, body),
  );
  const tab = h(
    "button",
    { type: "button", class: `rail-tab rail-tab-${side}`, "aria-label": `Show ${title.toLowerCase()}`, title: `Show ${title.toLowerCase()} (${side === "left" ? "[" : "]"})`, onclick: () => toggleRail(side, true) },
    h("span", { class: "rail-tab-glyph", "aria-hidden": "true" }, glyph),
    h("span", { class: "rail-tab-label" }, title.toLowerCase()),
  );
  return [panel, tab];
}

// ---------- rendering ----------
function showError(message: string): void {
  teardown.abort();
  hideTooltip();
  releaseTables();
  app.replaceChildren(
    h(
      "div",
      { class: "status error" },
      h("h1", {}, "Can't show this session"),
      h("p", {}, message),
      h("p", { class: "muted" }, "Links look like …/session/#owner/gistId (or #local:name when served locally)."),
    ),
  );
}

function currentView(): ShareMode {
  const requested = state.params.get("view") as ShareMode | null;
  return shared && requested && availableModes(shared.mode).includes(requested) ? requested : (shared?.mode ?? "full");
}

let activeTurn: TurnInfo | undefined;

/** What's at the top of the viewport, so a re-render (variant, view mode) can keep it there. */
type Anchor = { atTop: true } | { atTop: false; id: string; top: number; turnId?: string };

function captureAnchor(): Anchor | undefined {
  const entries = document.querySelectorAll<HTMLElement>(".transcript .entry[id]");
  if (!entries.length) return undefined;
  if (window.scrollY < 1) return { atTop: true };
  // The last entry whose top has passed the top edge (below the minibar).
  const line = cssPx("--top") + 8;
  let lo = 0;
  let hi = entries.length - 1;
  let found = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (entries[mid]!.getBoundingClientRect().top <= line) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  const el = entries[found]!;
  return { atTop: false, id: el.id, top: el.getBoundingClientRect().top, turnId: el.closest(".turn")?.id };
}

function restoreAnchor(anchor: Anchor): void {
  if (anchor.atTop) return window.scrollTo(0, 0);
  // Brief/minimal views group steps differently, so an entry may not exist there; then
  // fall back to the start of its turn.
  const el = document.getElementById(anchor.id);
  const target = el ?? (anchor.turnId ? document.getElementById(anchor.turnId) : null);
  if (!target) return;
  const top = el ? anchor.top : Math.min(anchor.top, cssPx("--top") + 8);
  window.scrollTo(0, window.scrollY + target.getBoundingClientRect().top - top);
}

function render(opts: { keepPlace?: boolean } = {}): void {
  if (!shared) return;
  // Before anything changes the layout (the new variant's styles included).
  const anchor = opts.keepPlace ? captureAnchor() : undefined;
  teardown.abort();
  teardown = new AbortController();
  const signal = teardown.signal;
  closeMenus();
  hideTooltip();
  releaseTables();
  const variant = currentVariant();
  applyVariant(variant);
  const view = currentView();
  const session = view === shared.mode ? shared : projectSession(shared, view);
  document.title = `${session.title ?? "Agent session"} · Agent Session`;

  const controls: Controls = { view, setView, toggleTheme, toggleRail, settings, local: state.source?.kind === "local" };
  const { el: transcript, turns } = renderTranscript(session, { inlineThinking: variant.inlineThinking });

  const jump = (id: string, smooth = true) => {
    const target = document.getElementById(id);
    if (!target) return;
    target.scrollIntoView({ behavior: smooth && !matchMedia("(prefers-reduced-motion: reduce)").matches ? "smooth" : "auto", block: "start" });
    if (!docked()) toggleRail("left", false);
    target.classList.remove("flash");
    void target.offsetWidth;
    target.classList.add("flash");
  };
  const toc = renderToc(turns, (id) => jump(id));
  const tokens = renderTokenRail(session, turns, (turn) => jump(`turn-${turn}`));
  const header = renderHeader(session, provenance, controls);
  const minibar = renderMinibar(session, turns, controls);

  const end = h("footer", { class: "end" }, h("span", {}, `end of session · ${plural(turns.filter((t) => t.ordinal).length, "prompt")}`));
  const page = h("div", { class: "page" }, header, transcript, end);
  app.replaceChildren(minibar.el, page, ...rail("left", "Contents", "≡", toc.el), ...rail("right", "Tokens", "∑", tokens.el));
  updateDock();

  // Scroll spy: the active turn is the last one whose top has passed a line near the
  // top of the viewport. Turns are in document order, so binary search.
  const spy = () => {
    const line = Math.min(window.innerHeight * 0.3, 160) + cssPx("--top");
    let lo = 0;
    let hi = turns.length - 1;
    let found = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (turns[mid]!.el.getBoundingClientRect().top <= line) {
        found = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    const t = turns[found];
    if (t && t !== activeTurn) {
      activeTurn = t;
      toc.setActive(t.index);
      tokens.setActive(t.index);
      minibar.setActive(t);
    }
    const max = document.documentElement.scrollHeight - window.innerHeight;
    minibar.setProgress(max > 0 ? window.scrollY / max : 0);
    root.dataset.compact = String(header.getBoundingClientRect().bottom < 0);
  };
  let queued = false;
  const onScroll = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      spy();
    });
  };
  window.addEventListener("scroll", onScroll, { passive: true, signal });
  window.addEventListener(
    "resize",
    () => {
      updateDock();
      onScroll();
    },
    { signal },
  );
  // Close an overlay rail when clicking outside it.
  document.addEventListener(
    "pointerdown",
    (e) => {
      if (docked() || (!overlayOpen.left && !overlayOpen.right)) return;
      const target = e.target as Element;
      if (target.closest(".rail, .rail-tab, .minibar")) return;
      overlayOpen.left = overlayOpen.right = false;
      syncRails();
    },
    { signal },
  );
  document.addEventListener("keydown", (e) => onKey(e, turns, jump, toc.focusSearch), { signal });

  activeTurn = undefined;
  if (anchor) {
    // Tables start at a default width until their observer fires; size them now so
    // the heights above the anchor are final before measuring.
    relayoutTables();
    restoreAnchor(anchor);
    // A variant's font may still be loading; once it lands, put the reader back unless
    // they've scrolled since.
    if (document.fonts?.status === "loading") {
      const settled = window.scrollY;
      void document.fonts.ready.then(() => {
        if (!signal.aborted && Math.abs(window.scrollY - settled) < 2) restoreAnchor(anchor);
      });
    }
  }
  spy();
}

function onKey(e: KeyboardEvent, turns: TurnInfo[], jump: (id: string) => void, focusSearch: () => void): void {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const el = e.target as HTMLElement | null;
  if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
  const prompts = turns.filter((t) => t.ordinal);
  // Where a jump puts a turn's top; "next"/"previous" are relative to that line.
  const land = (t: TurnInfo) => parseFloat(getComputedStyle(t.el).scrollMarginTop) || 0;
  switch (e.key) {
    case "j": {
      const next = prompts.find((t) => t.el.getBoundingClientRect().top > land(t) + 8);
      if (next) jump(next.id);
      break;
    }
    case "k": {
      const prev = [...prompts].reverse().find((t) => t.el.getBoundingClientRect().top < land(t) - 8);
      if (prev) jump(prev.id);
      break;
    }
    case "[":
      toggleRail("left");
      break;
    case "]":
      toggleRail("right");
      break;
    case "/":
      e.preventDefault();
      toggleRail("left", true);
      focusSearch();
      break;
    case "v":
    case "V": {
      const i = VARIANTS.findIndex((v) => v.id === currentVariant().id);
      setVariant(VARIANTS[(i + (e.key === "V" ? VARIANTS.length - 1 : 1)) % VARIANTS.length]!);
      break;
    }
    case "Escape":
      if (!docked()) {
        overlayOpen.left = overlayOpen.right = false;
        syncRails();
      }
      break;
    default:
      return;
  }
}

function setView(mode: ShareMode): void {
  if (mode === shared?.mode) state.params.delete("view");
  else state.params.set("view", mode);
  history.replaceState(null, "", formatHash(state));
  render({ keepPlace: true });
}

interface LocalShare {
  name: string;
  title?: string;
  harness?: string;
  mode?: string;
  turns?: number;
  error?: string;
}

/** `agent-share serve` exposes ./local/index.json; on a deployed viewer it simply 404s. */
async function showLocalPicker(): Promise<boolean> {
  let shares: LocalShare[];
  try {
    const res = await fetch("./local/index.json", { cache: "no-store" });
    if (!res.ok) return false;
    shares = (await res.json()) as LocalShare[];
  } catch {
    return false;
  }
  if (!Array.isArray(shares) || shares.length === 0) return false;
  teardown.abort();
  document.title = "Local sessions · Agent Session";
  const variant = state.params.get("variant");
  app.replaceChildren(
    h(
      "div",
      { class: "page picker" },
      h(
        "header",
        { class: "hdr" },
        h("div", { class: "hdr-top" }, h("h1", { class: "hdr-title" }, "Local sessions"), h("div", { class: "hdr-actions" }, settingsButton(settings))),
        h("p", { class: "fine" }, `Served by agent-share serve · ${plural(shares.length, "file")}`),
      ),
      h(
        "ul",
        { class: "picker-list" },
        ...shares.map((s) =>
          h(
            "li",
            {},
            h("a", { href: `#local:${encodeURIComponent(s.name)}${variant ? `&variant=${encodeURIComponent(variant)}` : ""}` }, s.title ?? s.name),
            h("span", { class: "fine" }, s.error ? `${s.name} · unreadable (${s.error})` : [s.name, HARNESS_LABEL[s.harness ?? ""] ?? s.harness, s.mode, s.turns !== undefined ? plural(s.turns, "turn") : ""].filter(Boolean).join(" · ")),
          ),
        ),
      ),
    ),
  );
  return true;
}

async function main(): Promise<void> {
  // Forget the previous share first: if this load fails, a later same-source hash change
  // (e.g. &view=brief) would otherwise re-render the old share under the new link.
  shared = undefined;
  provenance = undefined;
  activeTurn = undefined;
  applyVariant(currentVariant());
  closeMenus();
  if (!state.source) {
    if (await showLocalPicker()) return;
    return showError("No session in the link.");
  }
  try {
    const loaded = await loadSource(state.source);
    const data = loaded.data as NormalizedSession;
    if (!data || data.schema !== SCHEMA_VERSION) throw new Error(`Unsupported share format (${(data as { schema?: string })?.schema ?? "unknown"}).`);
    shared = data;
    provenance = loaded.provenance;
    render();
  } catch (err) {
    showError(err instanceof Error ? err.message : String(err));
  }
}

window.addEventListener("hashchange", () => {
  const next = parseHash(location.hash);
  const sameSource = JSON.stringify(next.source) === JSON.stringify(state.source);
  state = next;
  if (sameSource) render({ keepPlace: true });
  else void main();
});

void main();
