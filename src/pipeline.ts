import { hostname as osHostname, homedir, userInfo } from "node:os";
import { parseSession } from "./adapters/index.js";
import type { DropCounts, SubagentFileInput } from "./adapters/shared.js";
import type { AgentShareConfig } from "./config.js";
import { capRedacted } from "./cap.js";
import { capToolText, projectSession } from "./modes.js";
import { collectKnownSecrets, type KnownSecret, type KnownSourceUse } from "./redact/known-values.js";
import { Redactor, SECRET_CATEGORIES, redactSession, type RedactionFinding } from "./redact/index.js";
import { rescanPayload, type RescanIssue, type SuspiciousItem } from "./redact/rescan.js";
import type { HarnessName, NormalizedSession, SessionStats, ShareMode, Step } from "./schema.js";
import { computeStats } from "./stats.js";
import { TOOL_NAME, TOOL_VERSION } from "./version.js";

export interface PrepareOptions {
  mode: ShareMode;
  config: AgentShareConfig;
  harness?: HarnessName;
  leafId?: string;
  /** Subagent transcripts of the session (Claude Code); see `loadSubagentFiles`. */
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
  /** Medium-confidence matches still in the payload (rule, length, location; never the value): publishing needs a confirmation. */
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
  const { session: full, dropped } = parseSession(raw, opts.harness, { leafId: opts.leafId, subagentFiles: opts.subagentFiles });
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
  const { issues: rescan, suspicious } = rescanPayload(json, { knownSecrets, matchedSecrets: redactor.matchedSecrets(), homeDir: machine.homeDir, allowlist: redact.allowlist });
  const secretsFound = [...SECRET_CATEGORIES].some((c) => (counts[c] ?? 0) > 0);
  return {
    session,
    json,
    report: {
      harness: session.harness.name,
      sessionId: session.source.sessionId,
      title: session.title,
      mode: session.mode,
      stats: session.stats,
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
