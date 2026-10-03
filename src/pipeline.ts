import { hostname as osHostname, homedir, userInfo } from "node:os";
import { parseSession } from "./adapters/index.js";
import type { DropCounts, SubagentFileInput } from "./adapters/shared.js";
import type { AgentShareConfig } from "./config.js";
import { projectSession } from "./modes.js";
import { collectKnownSecrets, type KnownSecret, type KnownSourceUse } from "./redact/known-values.js";
import { Redactor, SECRET_CATEGORIES, redactSession, type RedactionFinding } from "./redact/index.js";
import { rescanPayload, type RescanIssue, type SuspiciousItem } from "./redact/rescan.js";
import type { HarnessName, NormalizedSession, SessionStats, ShareMode } from "./schema.js";
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
  const projected = projectSession(full, opts.mode, { maxToolChars: opts.config.maxToolChars });
  const session = redactSession(projected, redactor);
  if (derivedTitle && session.title) session.title = capTitle(session.title);
  const counts = Object.fromEntries(Object.entries(redactor.counts).filter(([, n]) => (n ?? 0) > 0)) as Record<string, number>;
  session.redaction = {
    total: Object.values(counts).reduce((a, b) => a + b, 0),
    byCategory: counts,
    dropped,
  };
  session.generator = { name: TOOL_NAME, version: TOOL_VERSION, sharedAt: (opts.now ?? new Date()).toISOString() };

  const json = JSON.stringify(session);
  const { issues: rescan, suspicious } = rescanPayload(json, { knownSecrets, homeDir: machine.homeDir, allowlist: redact.allowlist });
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

const TITLE_MAX = 80;
/** Replacement tokens the Redactor writes (`[REDACTED:rule]`, `[email]`, ...): one is never cut in half. */
const TOKEN = /\[[^\]\s]*\]/g;

/** Cap an already redacted title at `TITLE_MAX` characters, the last being an ellipsis. */
export function capTitle(title: string): string {
  if (title.length <= TITLE_MAX) return title;
  let cut = TITLE_MAX - 1;
  for (const m of title.matchAll(TOKEN)) {
    if (m.index < cut && m.index + m[0].length > cut) cut = m.index;
  }
  return `${title.slice(0, cut).trimEnd()}…`;
}

function safeUsername(): string | undefined {
  try {
    return userInfo().username;
  } catch {
    return process.env.USER;
  }
}
