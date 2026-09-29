/**
 * The session header, and the minibar that replaces it once it scrolls away: title,
 * the turn in view, reading progress and the controls, in one short line.
 */
import { formatCost, formatDuration, formatTokens } from "../../src/format.ts";
import { availableModes } from "../../src/modes.ts";
import { totalTokens, type NormalizedSession, type ShareMode } from "../../src/schema.ts";
import { h, provenanceLine, withTooltip } from "./dom.ts";
import { settingsButton, type SettingsOptions } from "./settings.ts";
import type { Provenance } from "./source.ts";
import type { TurnInfo } from "./transcript.ts";

export const HARNESS_LABEL: Record<string, string> = { "claude-code": "Claude Code", pi: "pi" };

export interface Controls {
  view: ShareMode;
  setView: (m: ShareMode) => void;
  toggleTheme: () => void;
  toggleRail: (side: "left" | "right") => void;
  settings: SettingsOptions;
  local: boolean;
}

function formatDate(iso?: string): string | undefined {
  if (!iso) return undefined;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? undefined : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function modeSwitch(s: NormalizedSession, c: Controls): HTMLElement {
  const modes = availableModes(s.mode);
  return h(
    "div",
    { class: "modes", role: "group", "aria-label": "View mode" },
    ...(["full", "brief", "minimal"] as ShareMode[]).map((m) =>
      h(
        "button",
        {
          type: "button",
          disabled: !modes.includes(m),
          title: modes.includes(m) ? `Show ${m} view` : `Shared as ${s.mode}; ${m} detail was not published`,
          "aria-pressed": String(m === c.view),
          onclick: () => c.setView(m),
        },
        m,
      ),
    ),
  );
}

function iconButton(label: string, glyph: string, onclick: () => void, cls = ""): HTMLElement {
  return h("button", { type: "button", class: `icon ${cls}`.trim(), "aria-label": label, title: label, onclick }, glyph);
}

/** A `dl` so variants can show it as "k: v" rows or as one "v · v · v" line. */
function facts(cls: string, rows: [string, string | Node | undefined][]): HTMLElement {
  return h("dl", { class: `facts ${cls}` }, ...rows.filter(([, v]) => v !== undefined && v !== "").map(([k, v]) => h("div", {}, h("dt", {}, k), h("dd", {}, v!))));
}

export function renderHeader(s: NormalizedSession, provenance: Provenance | undefined, c: Controls): HTMLElement {
  const st = s.stats;
  const harness = `${HARNESS_LABEL[s.harness.name] ?? s.harness.name}${s.harness.version ? ` ${s.harness.version}` : ""}`;
  const project = s.project?.name ? `${s.project.name}${s.project.branch ? ` @ ${s.project.branch}` : ""}` : undefined;
  const red = s.redaction;
  let redacted: HTMLElement | string = "none";
  if (red?.total) {
    redacted = h("span", { class: "has-tip", tabindex: "0" }, `${red.total} values`);
    const lines = Object.entries(red.byCategory).map(([k, n]) => `${n} ${k}`);
    withTooltip(redacted, () => ["Redacted before upload", ...lines]);
  }
  return h(
    "header",
    { class: "hdr" },
    h(
      "div",
      { class: "hdr-top" },
      h("h1", { class: "hdr-title" }, s.title ?? "Agent session"),
      h("div", { class: "hdr-actions" }, modeSwitch(s, c), iconButton("Toggle color theme", "", c.toggleTheme, "theme"), settingsButton(c.settings)),
    ),
    facts("facts-meta", [
      ["agent", harness],
      ["model", s.models.join(", ")],
      ["project", project],
      ["started", formatDate(s.startedAt)],
      ["duration", s.durationMs ? formatDuration(s.durationMs) : undefined],
    ]),
    facts("facts-stats", [
      ["turns", String(st.turns)],
      ["tools", `${st.toolCalls}${st.toolErrors ? ` (${st.toolErrors} err)` : ""}`],
      ["tokens", formatTokens(totalTokens(st.tokens))],
      ["peak ctx", formatTokens(st.peakContext)],
      ["cost", st.cost !== undefined ? formatCost(st.cost) : undefined],
      ["subagents", st.subagents ? String(st.subagents) : undefined],
    ]),
    h(
      "div",
      { class: "hdr-fine" },
      facts("facts-share", [
        ["shared", `${s.mode}${s.generator ? ` · ${formatDate(s.generator.sharedAt) ?? ""} via ${s.generator.name} ${s.generator.version}` : ""}`],
        ["redacted", redacted],
      ]),
      provenance ? provenanceLine(provenance) : null,
      c.local ? h("p", { class: "fine" }, h("a", { href: "#" }, "← all local sessions")) : null,
    ),
  );
}

export function renderMinibar(s: NormalizedSession, turns: TurnInfo[], c: Controls) {
  const prompts = turns.filter((t) => t.ordinal).length;
  const where = h("span", { class: "mb-where" });
  const label = h("span", { class: "mb-label" });
  const progress = h("div", { class: "mb-progress", "aria-hidden": "true" });
  // The bar spans the window; its contents line up with the rails' outer edges.
  const el = h(
    "div",
    { class: "minibar", role: "navigation", "aria-label": "Session" },
    h(
      "div",
      { class: "mb-inner" },
      iconButton("Toggle contents", "≡", () => c.toggleRail("left"), "mb-left"),
    h(
      "button",
      { type: "button", class: "mb-title", title: "Back to top", onclick: () => window.scrollTo({ top: 0, behavior: "smooth" }) },
      h("span", { class: "mb-name" }, s.title ?? "Agent session"),
    ),
      h("span", { class: "mb-turn" }, where, label),
      h("span", { class: "mb-spacer" }),
      modeSwitch(s, c),
      iconButton("Toggle color theme", "", c.toggleTheme, "theme"),
      settingsButton(c.settings),
      iconButton("Toggle token rail", "∑", () => c.toggleRail("right"), "mb-right"),
    ),
    progress,
  );
  const setActive = (t: TurnInfo | undefined) => {
    where.textContent = t?.ordinal ? `${t.ordinal}/${prompts}` : "";
    label.textContent = t?.ordinal ? t.label : "";
  };
  const setProgress = (p: number) => progress.style.setProperty("--p", String(Math.max(0, Math.min(1, p))));
  return { el, setActive, setProgress };
}
