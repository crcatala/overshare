import { hostname as osHostname, homedir, userInfo } from "node:os";
import { parseSession } from "./harnesses/index.js";
import type { DropCounts, SubagentFileInput } from "./harnesses/shared.js";
import type { OvershareConfig } from "./config.js";
import { capRedacted } from "./cap.js";
import { capToolText, projectSession } from "./modes.js";
import { collectKnownSecrets, type KnownSecret, type KnownSourceUse } from "./redact/known-values.js";
import { safeKeys, safeLabel } from "./redact/labels.js";
import { Redactor, SECRET_CATEGORIES, redactSession, type RedactionFinding } from "./redact/index.js";
import { rescanPayload, type RescanIssue, type SuspiciousItem } from "./redact/rescan.js";
import { sourceLocator } from "./redact/source-lines.js";
import type { HarnessName, NormalizedSession, SessionStats, ShareMode, Step, SubagentTotals } from "./schema.js";
import { computeStats } from "./stats.js";
import { TOOL_NAME, TOOL_VERSION } from "./version.js";

export interface PrepareOptions {
  mode: ShareMode;
  config: OvershareConfig;
  harness?: HarnessName;
  leafId?: string;
  /** Subagent transcripts of the session (for a harness that keeps them in files); see `loadSubagentFiles`. */
  subagentFiles?: SubagentFileInput[];
  /** Override machine context (tests). */
  machine?: { homeDir?: string; username?: string; hostname?: string };
  /** Pre-collected known secrets; collected from this machine when omitted. */
  knownSecrets?: KnownSecret[];
  /** Additional exact values to treat as secrets (e.g. from --secrets-file). */
  extraKnownSecrets?: KnownSecret[];
  now?: Date;
}

export interface ShareReport {
  harness: HarnessName;
  sessionId: string;
  title?: string;
  mode: ShareMode;
  stats: SessionStats;
  dropped: DropCounts;
  counts: Record<string, number>;
  findings: RedactionFinding[];
  rescan: RescanIssue[];
  /** Medium-confidence matches still in the payload (rule, length, location, source lines; never the value): publishing needs a confirmation. */
  suspicious: SuspiciousItem[];
  /** Where known values came from and how many each contributed (counts only), including sources that were switched off. */
  knownSources: KnownSourceUse[];
  bytes: number;
  /** No secrets were found, the final payload re-scan is clean and nothing suspicious is left. */
  clean: boolean;
  /** The final re-scan found something: publishing must be refused. */
  blocked: boolean;
}

export interface PreparedShare {
  session: NormalizedSession;
  json: string;
  report: ShareReport;
}

export function prepareShare(raw: string, opts: PrepareOptions): PreparedShare {
  const { session: full, dropped: droppedByEntry } = parseSession(raw, opts.harness, { leafId: opts.leafId, subagentFiles: opts.subagentFiles });
  // The adapters key these counts by entry type, subtype and custom type, all copied from the transcript, and the record is
  // published and reported in every mode while the Redactor never walks keys: each key must pass the identifier check (ass-t3hc).
  const dropped = safeKeys(droppedByEntry, "entry");
  full.stats = computeStats(full);
  // A missing title is the first line of the first prompt. It stays whole until it has been redacted and is cut
  // afterwards: cut first, a secret that straddles the cut leaves a half that no rule recognises (ass-ahh1).
  let derivedTitle = false;
  if (!full.title) {
    const first = full.turns.find((t) => t.user?.text)?.user?.text.split("\n", 1)[0]?.trim();
    if (first) {
      full.title = first;
      derivedTitle = true;
    }
  }
  if (full.startedAt && full.endedAt) {
    const ms = Date.parse(full.endedAt) - Date.parse(full.startedAt);
    if (Number.isFinite(ms) && ms >= 0) full.durationMs = ms;
  }

  const machine = {
    homeDir: opts.machine?.homeDir ?? homedir(),
    username: opts.machine?.username ?? safeUsername(),
    hostname: opts.machine?.hostname ?? osHostname(),
  };
  const { redact } = opts.config;
  const collected = opts.knownSecrets
    ? { secrets: opts.knownSecrets, sources: [{ id: "provided" as const, enabled: true, count: opts.knownSecrets.length }] }
    : collectKnownSecrets({ home: machine.homeDir, projectDir: full.project?.cwd, enabled: redact.knownSources });
  const extra = opts.extraKnownSecrets ?? [];
  const knownSources: KnownSourceUse[] = extra.length ? [...collected.sources, { id: "secrets-file", enabled: true, count: extra.length }] : collected.sources;
  const knownSecrets = [...collected.secrets, ...extra].sort((a, b) => b.value.length - a.value.length);
  const redactor = new Redactor({
    ...machine,
    redactEmails: redact.emails,
    redactUsername: redact.username,
    redactHostname: redact.hostname,
    knownSecrets,
    denylist: redact.denylist,
    allowlist: redact.allowlist,
  });

  // Project first so only content that will actually be published is redacted and reported.
  // Every length cap on text that reaches the payload runs AFTER redaction (ass-7x3c): the adapters keep summaries and
  // descriptions whole and projection cuts nothing, so a secret is never split by a cut and left as an unmatched prefix.
  const projected = projectSession(full, opts.mode);
  const session = capSummaries(capToolText(redactSession(projected, redactor), opts.config.maxToolChars));
  if (derivedTitle && session.title) session.title = capTitle(session.title);
  const counts = Object.fromEntries(Object.entries(redactor.counts).filter(([, n]) => (n ?? 0) > 0)) as Record<string, number>;
  session.redaction = {
    total: Object.values(counts).reduce((a, b) => a + b, 0),
    byCategory: counts,
    dropped,
  };
  session.generator = { name: TOOL_NAME, version: TOOL_VERSION, sharedAt: (opts.now ?? new Date()).toISOString() };

  const json = JSON.stringify(session);
  // Line numbers come from the source files, never from the payload. A subagent file is named by its position (the loader
  // sorts by file name), never by its name: that comes straight from disk, it is not redacted like the labels that are
  // derived from the payload, and no label check can know it does not contain a known value.
  const locate = sourceLocator([{ raw }, ...(opts.subagentFiles ?? []).map((f, i) => ({ name: `subagent-file-${i + 1}`, raw: f.raw }))]);
  const { issues: rescan, suspicious } = rescanPayload(json, { knownSecrets, matchedSecrets: redactor.matchedSecrets(), homeDir: machine.homeDir, allowlist: redact.allowlist, locate });
  const secretsFound = [...SECRET_CATEGORIES].some((c) => (counts[c] ?? 0) > 0);
  return {
    session,
    json,
    report: {
      harness: session.harness.name,
      sessionId: safeLabel(session.source.sessionId, "unknown"),
      title: session.title,
      mode: session.mode,
      stats: reportStats(session.stats),
      dropped,
      counts,
      findings: redactor.findings,
      rescan,
      suspicious,
      knownSources,
      bytes: Buffer.byteLength(json),
      clean: !secretsFound && rescan.length === 0 && suspicious.length === 0,
      blocked: rescan.length > 0,
    },
  };
}

/**
 * The stats as the report shows them. Model ids used as keys come from the transcript (tool names are already
 * `safeLabel`ed in `computeStats`), so each must pass the identifier check; a key that does not is replaced. The payload's
 * keys were redacted by `redactSession` already (ass-gmih); this is the backstop for what no secret rule recognises.
 */
function reportStats(stats: SessionStats): SessionStats {
  const totals = <T extends SubagentTotals>(t: T): T => ({ ...t, byModel: safeKeys(t.byModel, "model") });
  const sub = stats.subagentUsage;
  return {
    ...stats,
    ...(stats.rates ? { rates: safeKeys(stats.rates, "model") } : {}),
    ...(sub ? { subagentUsage: { ...totals(sub), ...(sub.unlinked ? { unlinked: totals(sub.unlinked) } : {}) } } : {}),
  };
}

/** Cap the one-line texts the adapters keep whole: tool summaries, subagent descriptions and the commands of a tool group. */
function capSummaries(session: NormalizedSession): NormalizedSession {
  const cap = (text: string) => capRedacted(text, SUMMARY_MAX);
  const turns = session.turns.map((turn) => ({
    ...turn,
    steps: turn.steps.map((s): Step => {
      // A file path is not cut: it was never capped, and the viewer shortens it relative to the project.
      if (s.kind === "tool") return s.action === "read" || s.action === "edit" || s.action === "write" ? s : { ...s, summary: cap(s.summary) };
      if (s.kind === "subagent") return s.description ? { ...s, description: cap(s.description) } : s;
      if (s.kind === "toolGroup") return { ...s, commands: s.commands.map(cap) };
      return s;
    }),
  }));
  return { ...session, turns };
}

const TITLE_MAX = 80;
/** A tool step's one-line summary and a subagent's description, as published. */
export const SUMMARY_MAX = 160;

/** Cap an already redacted title at `TITLE_MAX` characters, the last being an ellipsis; a replacement token is never cut. */
export const capTitle = (title: string): string => capRedacted(title, TITLE_MAX);

function safeUsername(): string | undefined {
  try {
    return userInfo().username;
  } catch {
    return process.env.USER;
  }
}
