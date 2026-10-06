import "./styles/fonts.css";
import "./styles/base.css";
import "./styles/classic.css";
import "./styles/cli.css";
import "./styles/log.css";
import { formatBytes, plural } from "../../src/format.ts";
import { projectSession, promptsUnavailableReason } from "../../src/modes.ts";
import type { NormalizedSession, ShareMode } from "../../src/schema.ts";
import { beacon } from "./beacon.ts";
import { bootLog, nextPaint } from "./boot.ts";
import { clearHits, pulseHits, refreshHits, showHits } from "./findhits.ts";
import { relayoutTables, releaseTables, setTableStyle } from "./asciitable.ts";
import { h, hideTooltip, toast } from "./dom.ts";
import { attribution } from "./attribution.ts";
import { readShare, type ReadShare } from "./compat.ts";
import { renderHeader, renderMinibar, type Controls } from "./header.ts";
import { closeMenus } from "./menu.ts";
import { renderCompatNotice } from "./notice.ts";
import { closeHoverCard } from "./popover.ts";
import type { SettingsOptions } from "./settings.ts";
import type { ShareOptions } from "./share.ts";
import { embeddedSource, formatHash, loadSource, parseHash, type HashState, type Provenance } from "./source.ts";
import { stepPrompt, typing, variantKeyStep, wheelMovesPage } from "./nav.ts";
import { fetchLocalShares, renderPicker } from "./picker.ts";
import { buildIndex } from "./search.ts";
import { renderToc } from "./toc.ts";
import { renderTokenRail } from "./tokens.ts";
import { renderTranscript, type TurnInfo } from "./transcript.ts";
import { findVariant, VARIANTS, type Variant } from "./variants.ts";
import { BUILT_IN, defaultsState, describe, formatUi, loadSaved, loadTab, parseUi, resolve, saveDefault, saveTab, viewFor, wantedView, type ViewSettings } from "./viewsettings.ts";
import { renderWelcome } from "./welcome.ts";

const app = document.getElementById("app") as HTMLElement;
const root = document.documentElement;

let shared: NormalizedSession | undefined;
/** Set when this share is from a newer format than the viewer reads, so it may not show completely (see compat.ts). */
let newer: ReadShare["newer"];
let provenance: Provenance | undefined;
/** The hash, plus the page's own session when it is a single-file export and the hash names no other. */
const readHash = (hash: string): HashState => {
  const parsed = parseHash(hash);
  return parsed.source ? parsed : { ...parsed, source: embeddedSource() };
};
let state: HashState = readHash(location.hash);
/** Listeners and observers of the current render, dropped on the next one. */
let teardown = new AbortController();

// ---------- view settings (see viewsettings.ts) ----------
/**
 * Take the view settings and prompt a link opened with, then drop them from the address
 * bar: it always shows the plain share link, and the share menu makes the others.
 */
function takeLinkParams(): { ui: Partial<ViewSettings>; turn?: number } {
  const ui = parseUi(state.params.get("ui"));
  const n = Number(state.params.get("turn"));
  if (state.params.has("ui") || state.params.has("turn")) {
    state.params.delete("ui");
    state.params.delete("turn");
    history.replaceState(null, "", formatHash(state));
  }
  return { ui, turn: Number.isInteger(n) && n > 0 ? n : undefined };
}

const opened = takeLinkParams();
let settings: ViewSettings = resolve(opened.ui, loadTab(), loadSaved() ?? {});
saveTab(settings);
/** A prompt the link asked to open at (`&turn=`), for the next render of a newly loaded share. */
let openAt = opened.turn;

function update(patch: Partial<ViewSettings>): void {
  settings = { ...settings, ...patch };
  saveTab(settings);
}

function shownTheme(): "light" | "dark" {
  if (settings.theme !== "system") return settings.theme;
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyTheme(): void {
  if (settings.theme === "system") delete root.dataset.theme;
  else root.dataset.theme = settings.theme;
}
applyTheme();

function toggleTheme(): void {
  update({ theme: shownTheme() === "dark" ? "light" : "dark" });
  applyTheme();
}

function currentVariant(): Variant {
  return findVariant(settings.variant)!;
}

function applyVariant(v: Variant): void {
  root.dataset.variant = v.id;
  setTableStyle(v.table);
}
applyVariant(currentVariant());

/** Show `settings` after more than one of them changed at once. */
function applySettings(): void {
  applyTheme();
  // render() applies the variant and rails itself, after noting where the reader is.
  if (shared) render({ keepPlace: true });
  else applyVariant(currentVariant());
}

function setVariant(v: Variant): void {
  update({ variant: v.id });
  applySettings();
}

/** The next (or previous) variant in the settings menu's order. */
function cycleVariant(dir: 1 | -1): void {
  const i = VARIANTS.findIndex((v) => v.id === currentVariant().id);
  setVariant(VARIANTS[(i + dir + VARIANTS.length) % VARIANTS.length]!);
}

const settingsMenu: SettingsOptions = {
  current: currentVariant,
  onPick: setVariant,
  defaults: () => defaultsState(settings, loadSaved()),
  saveDefault: () => {
    saveDefault(settings);
    toast("Saved as your default view");
  },
  resetDefault: () => {
    saveDefault(null);
    update(BUILT_IN);
    applySettings();
    toast("Back to the built-in default view");
  },
};

// ---------- rails ----------
type Side = "left" | "right";
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
  const open = docked() ? settings : overlayOpen;
  root.dataset.left = open.left ? "open" : "closed";
  root.dataset.right = open.right ? "open" : "closed";
  for (const side of ["left", "right"] as Side[]) {
    document.querySelector(`.rail-${side}`)?.toggleAttribute("inert", !open[side]);
  }
}

function toggleRail(side: Side, force?: boolean): void {
  if (docked()) {
    const next = force ?? !settings[side];
    update(side === "left" ? { left: next } : { right: next });
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
/** Replace what the page shows, dropping the current render's listeners and popups. */
function show(...nodes: Node[]): void {
  teardown.abort();
  closeHoverCard();
  hideTooltip();
  releaseTables();
  app.replaceChildren(...nodes);
}

/** `log`: the loading log, its failed stage marked, to show above the message. */
function showError(message: string, log?: HTMLElement): void {
  show(
    h(
      "div",
      { class: "status error" },
      log,
      h("h1", {}, "Can't show this session"),
      h("p", {}, message),
      h("p", { class: "muted" }, "Links look like …/s/#owner/gistId (or #local:name when served locally)."),
      h("p", {}, h("a", { href: "#" }, "Paste a link or see an example")),
    ),
  );
  document.title = "Can't show this session · overshare";
}

function currentView(): ShareMode {
  return shared ? viewFor(settings.view, shared.mode, !promptsUnavailableReason(shared)) : "full";
}

let activeTurn: TurnInfo | undefined;
/** The prompt (index among prompts) the last j/k jump went to; see stepPrompt. Dropped once the reader scrolls themselves. */
let navCursor: number | undefined;

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

/** `keepPlace`: keep what's at the top of the viewport there. `turn`: open at this prompt instead. */
function render(opts: { keepPlace?: boolean; turn?: number } = {}): void {
  if (!shared) return;
  // Before anything changes the layout (the new variant's styles included).
  const anchor = opts.keepPlace ? captureAnchor() : undefined;
  teardown.abort();
  teardown = new AbortController();
  const signal = teardown.signal;
  closeMenus();
  closeHoverCard();
  hideTooltip();
  releaseTables();
  clearHits();
  const variant = currentVariant();
  applyVariant(variant);
  const view = currentView();
  const sharedMode = shared.mode;
  const session = view === sharedMode ? shared : projectSession(shared, view);
  document.title = `${session.title ?? "Agent session"} · overshare`;

  const share: ShareOptions = {
    source: state.source!,
    view: () => {
      const shown = { ...settings, view, theme: shownTheme() };
      return { ui: formatUi({ ...shown, view: wantedView(view, sharedMode) }), label: describe(shown) };
    },
    turn: () => (activeTurn?.ordinal ? { ordinal: activeTurn.ordinal, label: activeTurn.label } : undefined),
  };
  const controls: Controls = { sharedMode, promptsUnavailable: promptsUnavailableReason(shared), view, setView, toggleTheme, toggleRail, settings: settingsMenu, share, local: state.source?.kind === "local" };
  const { el: transcript, turns } = renderTranscript(session, { inlineThinking: variant.inlineThinking });
  /** What the transcript couldn't draw (a newer format's steps, or ones that failed): the notice counts and links them. */
  const gaps = Array.from(transcript.querySelectorAll<HTMLElement>(".k-unsupported"));

  const jump = (id: string, smooth = true) => {
    const target = document.getElementById(id);
    if (!target) return;
    target.scrollIntoView({ behavior: smooth && !matchMedia("(prefers-reduced-motion: reduce)").matches ? "smooth" : "auto", block: "start" });
    if (!docked()) toggleRail("left", false);
    beacon(target, pulseHits);
  };
  // Clicking a filter result outlines the words it matched, wherever they sit in the entry;
  // they stay until the filter changes or another result is clicked. Other jumps leave them.
  const toc = renderToc(
    turns,
    (id, hit) => {
      if (hit) showHits(hit.ids, hit.tokens, { reveal: hit.reveal, count: hit.count });
      else clearHits();
      jump(id);
    },
    // The index is built from `session`, the redacted share projected to this view: only text it can show is found.
    { detail: settings.toc, onDetail: (d) => update({ toc: d }), onClear: clearHits, index: () => buildIndex(session) },
  );
  // Opening or closing an entry moves its text between the preview and the full view; the outlines follow.
  transcript.addEventListener("click", (e) => {
    if ((e.target as Element).closest("button.tline, button.more")) refreshHits();
  });
  const tokens = renderTokenRail(
    session,
    turns,
    (turn) => jump(`turn-${turn}`),
    (id) => {
      jump(id);
      // An overlay rail would cover what was just scrolled to.
      if (!docked()) toggleRail("right", false);
    },
  );
  const header = renderHeader(session, provenance, controls);
  const minibar = renderMinibar(session, turns, controls);

  const end = h("footer", { class: "end" }, h("span", {}, `end of session · ${plural(turns.filter((t) => t.ordinal).length, "prompt")}`), attribution());
  const page = h("div", { class: "page" }, header, newer ? renderCompatNotice(newer, { count: gaps.length, goToFirst: () => jump(gaps[0]!.id) }) : null, transcript, end);
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
  // Scrolling by hand (wheel, touch, scrollbar; keys are handled in onKey) makes the last j/k target stale.
  const dropCursor = () => (navCursor = undefined);
  for (const type of ["touchmove", "pointerdown"]) window.addEventListener(type, dropCursor, { passive: true, signal });
  window.addEventListener("wheel", (e) => wheelMovesPage(e.deltaY, window.scrollY, root.scrollHeight - window.innerHeight) && dropCursor(), { passive: true, signal });

  activeTurn = undefined;
  navCursor = undefined;
  const target = opts.turn ? turns.find((t) => t.ordinal === opts.turn) : undefined;
  const land = target ? () => target.el.scrollIntoView({ block: "start" }) : anchor ? () => restoreAnchor(anchor) : undefined;
  if (land) {
    // Tables start at a default width until their observer fires; size them now so
    // the heights above the landing spot are final before measuring.
    relayoutTables();
    land();
    if (target) beacon(target.el);
    // The font may still be loading; once it lands, put the reader back unless
    // they've scrolled since.
    if (document.fonts?.status === "loading") {
      const settled = window.scrollY;
      void document.fonts.ready.then(() => {
        if (!signal.aborted && Math.abs(window.scrollY - settled) < 2) land();
      });
    }
  }
  spy();
}

function onKey(e: KeyboardEvent, turns: TurnInfo[], jump: (id: string) => void, focusSearch: () => void): void {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key !== "j" && e.key !== "k") navCursor = undefined;
  if (typing(e)) return;
  const prompts = turns.filter((t) => t.ordinal);
  // Where a jump puts a turn's top; "next"/"previous" are relative to that line.
  const land = parseFloat(getComputedStyle(prompts[0]?.el ?? document.body).scrollMarginTop) || 0;
  const step = (dir: 1 | -1) => {
    const tops = prompts.map((t) => t.el.getBoundingClientRect().top);
    const atBottom = window.scrollY >= root.scrollHeight - window.innerHeight - 1;
    const to = stepPrompt(dir, tops, land, atBottom, navCursor);
    if (to === undefined) return;
    navCursor = to;
    jump(prompts[to]!.id);
  };
  switch (e.key) {
    case "j":
      step(1);
      break;
    case "k":
      step(-1);
      break;
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
    case "V":
      cycleVariant(e.key === "V" ? -1 : 1);
      break;
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
  if (shared) update({ view: wantedView(mode, shared.mode) });
  render({ keepPlace: true });
}

/** Show a page without a share (the picker, the start page), where v / V still cycle the variant. */
function showPage(title: string, page: HTMLElement): void {
  show(page);
  teardown = new AbortController();
  document.title = title;
  document.addEventListener(
    "keydown",
    (e) => {
      const dir = variantKeyStep(e);
      if (dir) cycleVariant(dir);
    },
    { signal: teardown.signal },
  );
}

/**
 * Show the local sessions page when the viewer was opened without a share and there are some to pick.
 * `current`: false once a newer link has taken over, which then shows instead.
 */
async function showLocalPicker(current: () => boolean): Promise<boolean> {
  const shares = await fetchLocalShares();
  if (!shares || !current()) return false;
  showPage("Local sessions · overshare", renderPicker(shares, { settings: settingsMenu, toggleTheme }));
  return true;
}

/** Counts loads, so one that a newer link overtook doesn't render over it. */
let loads = 0;

async function main(): Promise<void> {
  const load = ++loads;
  // Forget the previous share first: if this load fails, a later same-source hash change
  // (e.g. &turn=3) would otherwise re-render the old share under the new link.
  const turn = openAt;
  openAt = undefined;
  shared = undefined;
  newer = undefined;
  provenance = undefined;
  activeTurn = undefined;
  navCursor = undefined;
  applyVariant(currentVariant());
  closeMenus();
  const current = () => load === loads;
  if (!state.source) {
    // Something after the # that names no share is a broken link, not a visit to the start page.
    const head = location.hash.replace(/^#/, "").split("&")[0];
    if (head) return showError(`"#${head}" doesn't name a session.`);
    if (await showLocalPicker(current)) return;
    if (current()) showPage("overshare · session viewer", renderWelcome({ settings: settingsMenu, toggleTheme }));
    return;
  }
  // The first load continues the log index.html shows; a later one (a link to another share) starts a new one.
  const boot = bootLog(load === 1 ? app.querySelector<HTMLElement>(":scope > .loading") : undefined);
  if (!app.contains(boot.el)) show(boot.el);
  try {
    const loaded = await loadSource(state.source, location.href, (url) => boot.step("fetching", url.origin === location.origin ? url.pathname : url.host));
    const schema = (loaded.data as { schema?: unknown } | null)?.schema;
    boot.step("reading", `${typeof schema === "string" ? `${schema} · ` : ""}${formatBytes(loaded.size)}`);
    const read = await readShare(loaded.data);
    if (!current()) return;
    const data = read.session;
    const reason = data.mode === "prompts" ? promptsUnavailableReason(data) : undefined;
    if (reason) throw new Error(reason);
    boot.step(`rendering ${plural(data.turns.length, "turn")}`);
    await nextPaint();
    if (!current()) return;
    shared = data;
    newer = read.newer;
    provenance = loaded.provenance;
    render({ turn });
  } catch (err) {
    if (current()) showError(err instanceof Error ? err.message : String(err), boot.fail());
  }
}

window.addEventListener("hashchange", () => {
  const previous = state.source;
  state = readHash(location.hash);
  const { ui, turn } = takeLinkParams();
  update(ui);
  applyTheme();
  // Without a share either side, the hash went from a broken link to none (or back): show what it is now.
  if (JSON.stringify(state.source) !== JSON.stringify(previous) || (!state.source && !previous)) {
    openAt = turn;
    void main();
  } else if (shared) render({ keepPlace: true, turn });
  // The picker or an error: nothing to re-render, only the variant to restyle with.
  else applyVariant(currentVariant());
});

void main();
