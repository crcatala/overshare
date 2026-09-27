import { hostname as osHostname, homedir, userInfo } from "node:os";
import { parseSession } from "./adapters/index.js";
import type { DropCounts } from "./adapters/shared.js";
import type { AgentShareConfig } from "./config.js";
import { projectSession } from "./modes.js";
import { collectKnownSecrets, type KnownSecret } from "./redact/known-values.js";
import { Redactor, SECRET_CATEGORIES, redactSession, type RedactionFinding } from "./redact/index.js";
import { rescanPayload, type RescanIssue } from "./redact/rescan.js";
import type { HarnessName, NormalizedSession, SessionStats, ShareMode } from "./schema.js";
import { computeStats } from "./stats.js";
import { TOOL_NAME, TOOL_VERSION } from "./version.js";

export interface PrepareOptions {
  mode: ShareMode;
  config: AgentShareConfig;
  harness?: HarnessName;
  leafId?: string;
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
  knownSecretCount: number;
  bytes: number;
  /** No secrets were found and the final payload re-scan is clean. */
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
  const { session: full, dropped } = parseSession(raw, opts.harness, { leafId: opts.leafId });
  full.stats = computeStats(full);
  if (!full.title) {
    const first = full.turns.find((t) => t.user?.text)?.user?.text.split("\n", 1)[0]?.trim();
    if (first) full.title = first.length > 80 ? `${first.slice(0, 79)}…` : first;
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
  const knownSecrets = [
    ...(opts.knownSecrets ?? collectKnownSecrets({ home: machine.homeDir, projectDir: full.project?.cwd })),
    ...(opts.extraKnownSecrets ?? []),
  ].sort((a, b) => b.value.length - a.value.length);
  const { redact } = opts.config;
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
  const counts = Object.fromEntries(Object.entries(redactor.counts).filter(([, n]) => (n ?? 0) > 0)) as Record<string, number>;
  session.redaction = {
    total: Object.values(counts).reduce((a, b) => a + b, 0),
    byCategory: counts,
    dropped,
  };
  session.generator = { name: TOOL_NAME, version: TOOL_VERSION, sharedAt: (opts.now ?? new Date()).toISOString() };

  const json = JSON.stringify(session);
  const rescan = rescanPayload(json, { knownSecrets, homeDir: machine.homeDir, allowlist: redact.allowlist });
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
      knownSecretCount: knownSecrets.length,
      bytes: Buffer.byteLength(json),
      clean: !secretsFound && rescan.length === 0,
      blocked: rescan.length > 0,
    },
  };
}

function safeUsername(): string | undefined {
  try {
    return userInfo().username;
  } catch {
    return process.env.USER;
  }
}
