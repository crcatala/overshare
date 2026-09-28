import "./styles.css";
import { formatCost, formatDuration, formatTokens, plural } from "../../src/format.ts";
import { availableModes, projectSession } from "../../src/modes.ts";
import {
  SCHEMA_VERSION,
  totalTokens,
  type EventStep,
  type NormalizedSession,
  type ShareMode,
  type Step,
  type SubagentStep,
  type ThinkingStep,
  type ToolGroupStep,
  type ToolStep,
  type Turn,
} from "../../src/schema.ts";
import { h, lazyDetails, markdown } from "./dom.ts";
import { buildScale, railLegend, renderRail, type RailScale } from "./rail.ts";
import { formatHash, loadSource, parseHash, type HashState, type Provenance } from "./source.ts";

const app = document.getElementById("app") as HTMLElement;
const HARNESS_LABEL: Record<string, string> = { "claude-code": "Claude Code", pi: "pi" };
const EVENT_ICON: Record<string, string> = {
  model_change: "⇄",
  thinking_level: "◐",
  compaction: "⤓",
  command: "⌘",
  skill: "✦",
  subagent_notice: "🤖",
  interrupted: "⏹",
  error: "⚠",
};

let shared: NormalizedSession | undefined;
let provenance: Provenance | undefined;
let state: HashState = parseHash(location.hash);

// ---------- theme ----------
function applyTheme(theme: string | null): void {
  if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
}
function storedTheme(): string | null {
  try {
    return localStorage.getItem("agent-share-theme");
  } catch {
    return null;
  }
}
function storeTheme(theme: string): void {
  try {
    localStorage.setItem("agent-share-theme", theme);
  } catch {
    // storage unavailable (private mode, sandbox)
  }
}
applyTheme(storedTheme());

// ---------- rendering ----------
function showError(message: string): void {
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

function tile(label: string, value: string, hint?: string): HTMLElement {
  return h("div", { class: "tile" }, h("div", { class: "tile-label" }, label), h("div", { class: "tile-value" }, value), hint ? h("div", { class: "tile-hint" }, hint) : null);
}

function formatDate(iso?: string): string | undefined {
  if (!iso) return undefined;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? undefined : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** Where the share was fetched from; everything else in the header is the sharer's own claim. */
function renderProvenance(p: Provenance): HTMLElement {
  return h(
    "p",
    { class: "fine provenance" },
    "Loaded from ",
    p.href ? h("a", { href: p.href, target: "_blank", rel: "noopener noreferrer" }, p.label) : p.label,
    " · the transcript is shown as published and isn't verified",
  );
}

function renderHeader(s: NormalizedSession, view: ShareMode): HTMLElement {
  const st = s.stats;
  const meta = [
    `${HARNESS_LABEL[s.harness.name] ?? s.harness.name}${s.harness.version ? ` ${s.harness.version}` : ""}`,
    s.models.join(", "),
    s.project?.name ? `${s.project.name}${s.project.branch ? ` @ ${s.project.branch}` : ""}` : undefined,
    formatDate(s.startedAt),
    s.durationMs ? formatDuration(s.durationMs) : undefined,
  ].filter(Boolean) as string[];

  const tiles = h(
    "div",
    { class: "tiles" },
    tile("Turns", String(st.turns)),
    tile("Tool calls", String(st.toolCalls), st.toolErrors ? `${st.toolErrors} errors` : undefined),
    tile("Tokens", formatTokens(totalTokens(st.tokens)), `out ${formatTokens(st.tokens.output)}`),
    tile("Peak context", formatTokens(st.peakContext)),
    st.cost !== undefined ? tile("Cost", formatCost(st.cost), st.costSource === "session-total" ? "session total" : undefined) : null,
    st.subagents ? tile("Subagents", String(st.subagents)) : null,
    st.thinking.tokens || st.thinking.blocks ? tile("Thinking", st.thinking.tokens ? `${formatTokens(st.thinking.tokens)} tok` : plural(st.thinking.blocks, "block")) : null,
  );

  const modes = availableModes(s.mode);
  const switcher = h(
    "div",
    { class: "segmented", role: "group", "aria-label": "View mode" },
    ...(["full", "brief", "minimal"] as ShareMode[]).map((m) =>
      h(
        "button",
        {
          type: "button",
          class: m === view ? "active" : "",
          disabled: !modes.includes(m),
          title: modes.includes(m) ? `Show ${m} view` : `Shared as ${s.mode}; ${m} detail was not published`,
          "aria-pressed": String(m === view),
          onclick: () => setView(m),
        },
        m,
      ),
    ),
  );

  const themeBtn = h(
    "button",
    {
      type: "button",
      class: "ghost",
      "aria-label": "Toggle color theme",
      onclick: () => {
        const dark = document.documentElement.dataset.theme
          ? document.documentElement.dataset.theme === "dark"
          : matchMedia("(prefers-color-scheme: dark)").matches;
        const next = dark ? "light" : "dark";
        applyTheme(next);
        storeTheme(next);
      },
    },
    "◑",
  );

  const tools = Object.entries(st.tools).sort((a, b) => b[1] - a[1]);
  const maxTool = tools[0]?.[1] ?? 1;
  const toolBars = tools.length
    ? lazyDetails(
        h("span", {}, `Tool usage · ${plural(tools.length, "tool")}`),
        () =>
          h(
            "div",
            { class: "barlist" },
            ...tools.map(([name, count]) => {
              const bar = h("div", { class: "barlist-bar" });
              bar.style.width = `${Math.max(2, (count / maxTool) * 100)}%`;
              return h("div", { class: "barlist-row" }, h("span", { class: "barlist-name" }, name), h("div", { class: "barlist-track" }, bar), h("span", { class: "barlist-value" }, String(count)));
            }),
          ),
        { open: tools.length <= 8, className: "panel" },
      )
    : null;

  const red = s.redaction;
  const redParts = red ? Object.entries(red.byCategory).map(([k, n]) => `${n} ${k}`) : [];
  const files = st.files.read + st.files.edited + st.files.written;
  return h(
    "header",
    { class: "session-header" },
    h("div", { class: "header-top" }, h("h1", {}, s.title ?? "Agent session"), h("div", { class: "header-actions" }, switcher, themeBtn)),
    h("p", { class: "meta" }, meta.join(" · ")),
    state.source?.kind === "local" ? h("p", { class: "fine" }, h("a", { href: "#" }, "← All local sessions")) : null,
    tiles,
    files ? h("p", { class: "meta" }, `Files: ${st.files.read} read · ${st.files.edited} edited · ${st.files.written} written`) : null,
    toolBars,
    h(
      "p",
      { class: "fine" },
      `Shared as ${s.mode}`,
      s.generator ? ` · ${formatDate(s.generator.sharedAt) ?? ""} via ${s.generator.name} ${s.generator.version}` : "",
      redParts.length ? ` · redacted: ${redParts.join(", ")}` : " · no redactions",
    ),
    provenance ? renderProvenance(provenance) : null,
    s.responses.length ? railLegend() : null,
  );
}

function pre(text: string, className = ""): HTMLElement {
  return h("pre", { class: className }, h("code", {}, text));
}

function renderToolInput(step: ToolStep): Node {
  const input = (step.input ?? {}) as Record<string, unknown>;
  const n = step.name.toLowerCase();
  if ((n === "bash" || n === "shell") && typeof input.command === "string") return pre(input.command, "cmd");
  if (n === "edit" && typeof input.old_string === "string") {
    return h("div", { class: "diff" }, pre(String(input.old_string), "del"), pre(String(input.new_string ?? ""), "add"));
  }
  if (n === "edit" && Array.isArray(input.edits)) {
    return h(
      "div",
      { class: "diff" },
      ...(input.edits as Record<string, unknown>[]).flatMap((e) => [pre(String(e.oldText ?? e.old_string ?? ""), "del"), pre(String(e.newText ?? e.new_string ?? ""), "add")]),
    );
  }
  if (n === "write" && typeof input.content === "string") return pre(input.content);
  return pre(JSON.stringify(input, null, 2));
}

function renderTool(step: ToolStep): HTMLElement {
  const summary = h(
    "span",
    { class: "tool-summary" },
    h("span", { class: `badge tool-name${step.isError ? " is-error" : ""}` }, step.name),
    h("span", { class: "tool-desc" }, step.summary || ""),
    step.isError ? h("span", { class: "err-mark", title: "Tool returned an error" }, "error") : null,
  );
  const hasDetail = step.input !== undefined || step.result;
  if (!hasDetail) return h("div", { class: "tool" }, summary);
  return lazyDetails(
    summary,
    () =>
      h(
        "div",
        { class: "tool-body" },
        step.input !== undefined ? h("div", { class: "io-label" }, "Input") : null,
        step.input !== undefined ? renderToolInput(step) : null,
        step.result ? h("div", { class: "io-label" }, step.result.isError ? "Error" : "Result", step.result.images ? ` · ${plural(step.result.images, "image")} omitted` : "") : null,
        step.result ? pre(step.result.text || "(empty)", step.result.isError ? "result is-error" : "result") : null,
      ),
    { className: "tool" },
  );
}

function renderGroup(g: ToolGroupStep): HTMLElement {
  const chips = h(
    "span",
    { class: "chips" },
    ...g.calls.map((c) => h("span", { class: `chip${c.errors ? " is-error" : ""}` }, `${c.name} ×${c.count}`)),
    g.thinking ? h("span", { class: "chip chip-muted" }, `thinking ${g.thinking.tokens ? `${formatTokens(g.thinking.tokens)} tok` : plural(g.thinking.blocks, "block")}`) : null,
  );
  const fileLine = (label: string, list: string[]) =>
    list.length ? h("div", { class: "group-files" }, h("span", { class: "io-label" }, `${label} (${list.length})`), h("ul", {}, ...list.map((f) => h("li", {}, h("code", {}, f))))) : null;
  const hasDetail = g.commands.length || g.files.read.length || g.files.edited.length || g.files.written.length;
  const summaryText = [
    g.files.read.length ? `read ${plural(g.files.read.length, "file")}` : "",
    g.files.edited.length ? `edited ${plural(g.files.edited.length, "file")}` : "",
    g.files.written.length ? `wrote ${plural(g.files.written.length, "file")}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const summary = h("span", { class: "tool-summary" }, chips, summaryText ? h("span", { class: "tool-desc" }, summaryText) : null);
  if (!hasDetail) return h("div", { class: "group" }, summary);
  return lazyDetails(
    summary,
    () =>
      h(
        "div",
        { class: "tool-body" },
        g.commands.length ? h("div", { class: "io-label" }, `Commands (${g.commands.length})`) : null,
        g.commands.length ? pre(g.commands.join("\n"), "cmd") : null,
        fileLine("Read", g.files.read),
        fileLine("Edited", g.files.edited),
        fileLine("Written", g.files.written),
      ),
    { className: "group" },
  );
}

function renderThinking(t: ThinkingStep): HTMLElement {
  const label = `Thinking${t.blocks > 1 ? ` · ${t.blocks} blocks` : ""}${t.tokens ? ` · ${formatTokens(t.tokens)} tok` : t.chars ? ` · ${formatTokens(t.chars)} chars` : ""}`;
  if (!t.text) return h("div", { class: "thinking" }, h("span", { class: "chip chip-muted" }, label));
  return lazyDetails(h("span", { class: "chip chip-muted" }, label), () => markdown(t.text ?? ""), { className: "thinking" });
}

function renderSubagent(s: SubagentStep): HTMLElement {
  const u = s.usage;
  const stats = u
    ? [
        u.totalTokens ? `${formatTokens(u.totalTokens)} tok` : u.input !== undefined ? `${formatTokens((u.input ?? 0) + (u.cacheRead ?? 0) + (u.output ?? 0))} tok` : "",
        u.turns ? plural(u.turns, "turn") : "",
        u.toolUses ? plural(u.toolUses, "tool call") : "",
        u.durationMs ? formatDuration(u.durationMs) : "",
        u.cost !== undefined ? formatCost(u.cost) : "",
      ].filter(Boolean)
    : [];
  const head = h(
    "div",
    { class: "subagent-head" },
    h("span", { class: "badge subagent-badge" }, "🤖 subagent"),
    h("strong", {}, s.agents.length ? s.agents.join(", ") : s.tool),
    s.mode ? h("span", { class: "muted" }, s.mode) : null,
    s.async ? h("span", { class: "muted" }, "async") : null,
    s.isError ? h("span", { class: "err-mark" }, "error") : null,
  );
  return h(
    "div",
    { class: "subagent" },
    head,
    s.description ? h("div", { class: "subagent-desc" }, s.description) : null,
    stats.length ? h("div", { class: "muted small" }, stats.join(" · ")) : null,
    s.result ? lazyDetails(h("span", {}, "Result"), () => pre(s.result?.text ?? ""), { className: "subagent-result" }) : null,
  );
}

function renderEvent(e: EventStep): HTMLElement {
  const label = h("span", { class: "event-text" }, `${EVENT_ICON[e.event] ?? "•"} ${e.text}`);
  if (!e.detail) return h("div", { class: `event event-${e.event}` }, label);
  return lazyDetails(label, () => (e.event === "compaction" ? markdown(e.detail ?? "") : pre(e.detail ?? "")), { className: `event event-${e.event}` });
}

function renderStep(step: Step): HTMLElement {
  switch (step.kind) {
    case "text":
      return h("div", { class: "assistant" }, markdown(step.text));
    case "thinking":
      return renderThinking(step);
    case "tool":
      return renderTool(step);
    case "toolGroup":
      return renderGroup(step);
    case "subagent":
      return renderSubagent(step);
    case "event":
      return renderEvent(step);
  }
}

function renderTurn(turn: Turn, scale: RailScale, ordinal: number): HTMLElement {
  const u = turn.user;
  const prompt = u
    ? h(
        "div",
        { class: "prompt" },
        h("div", { class: "prompt-label" }, u.command ? h("span", { class: "badge" }, "command") : "You", u.images ? h("span", { class: "muted" }, ` · ${plural(u.images, "image")} omitted`) : null),
        u.command && !u.expanded ? h("pre", { class: "cmd" }, h("code", {}, u.text)) : markdown(u.text),
        u.expanded ? lazyDetails(h("span", {}, "Expanded prompt"), () => markdown(u.expanded ?? ""), { className: "expanded" }) : null,
      )
    : null;
  const time = turn.timestamp ? new Date(turn.timestamp).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) : "";
  return h(
    "section",
    { class: "turn", id: `turn-${turn.index}` },
    h(
      "div",
      { class: "turn-main" },
      h("a", { class: "turn-anchor", href: `#turn-${turn.index}`, onclick: (e: Event) => e.preventDefault() }, u ? `Turn ${ordinal}${time ? ` · ${time}` : ""}` : "Session start"),
      prompt,
      ...turn.steps.map(renderStep),
    ),
    renderRail(turn.index, scale) ?? h("aside", { class: "rail rail-empty" }),
  );
}

function render(): void {
  if (!shared) return;
  const requested = state.params.get("view") as ShareMode | null;
  const modes = availableModes(shared.mode);
  const view = requested && modes.includes(requested) ? requested : shared.mode;
  const session = view === shared.mode ? shared : projectSession(shared, view);
  const scale = buildScale(session);
  document.title = `${session.title ?? "Agent session"} · Agent Session`;
  let ordinal = 0;
  const turns = session.turns.filter((t) => t.user || t.steps.length).map((t) => renderTurn(t, scale, t.user ? ++ordinal : 0));
  app.replaceChildren(renderHeader(session, view), h("div", { class: "turns" }, ...turns));
}

function setView(mode: ShareMode): void {
  if (mode === shared?.mode) state.params.delete("view");
  else state.params.set("view", mode);
  history.replaceState(null, "", formatHash(state));
  render();
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
  document.title = "Local sessions · Agent Session";
  app.replaceChildren(
    h(
      "section",
      { class: "session-header picker" },
      h("h1", {}, "Local sessions"),
      h("p", { class: "meta" }, `Served by agent-share serve · ${plural(shares.length, "file")}`),
      h(
        "ul",
        { class: "picker-list" },
        ...shares.map((s) =>
          h(
            "li",
            {},
            h("a", { href: `#local:${encodeURIComponent(s.name)}` }, s.title ?? s.name),
            h(
              "span",
              { class: "muted small" },
              s.error ? ` · ${s.name} · unreadable (${s.error})` : ` · ${[s.name, HARNESS_LABEL[s.harness ?? ""] ?? s.harness, s.mode, s.turns !== undefined ? plural(s.turns, "turn") : ""].filter(Boolean).join(" · ")}`,
            ),
          ),
        ),
      ),
    ),
  );
  return true;
}

async function main(): Promise<void> {
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
  if (sameSource) render();
  else void main();
});

void main();
