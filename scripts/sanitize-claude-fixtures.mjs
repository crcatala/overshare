#!/usr/bin/env node
/**
 * Turns real Claude Code transcripts from a throwaway sandbox repo into committable fixtures.
 *
 *   node scripts/sanitize-claude-fixtures.mjs <project-dir> <out-dir> [session-id-prefix...]
 *
 * `<project-dir>` is one project directory of `~/.claude/projects` (holding `<id>.jsonl` and
 * `<id>/subagents/agent-*.{jsonl,meta.json}`). Only feed it sessions generated for this purpose:
 * it removes what it knows to be private and refuses to write anything that still looks private,
 * but it cannot judge prompts or tool output.
 *
 * - Drops the large injected-context attachments (prompt snapshot, skill / agent / MCP listings,
 *   credential org, ...) and file-history snapshots. Small attachments stay so the adapter's drop
 *   paths still run. Kept lines are re-linked over the dropped ones, so `parentUuid` chains hold.
 * - Keeps every `usage` object, `cost-state`, `queue-operation`, `origin`, task-notification and
 *   `meta.json` as recorded (apart from path scrubbing), so usage arithmetic is unchanged.
 * - Replaces this machine's home directory, username and temp paths with neutral ones.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const KEEP_ATTACHMENTS = new Set(["date", "model", "total_tokens_reminder", "budget_usd", "queued_command"]);
const DROP_TYPES = new Set(["file-history-snapshot"]);
const SIGNATURE = "fixture-signature";

const FIXTURE_HOME = "/home/fixture-user";
const FIXTURE_CWD = `${FIXTURE_HOME}/work/usage-sandbox`;
const FIXTURE_SLUG = "-home-fixture-user-work-usage-sandbox";

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Text-level scrub applied to a serialized JSON line (no replacement contains JSON metacharacters). */
export function makeScrub(home, user) {
  const tmp = new RegExp(`${escapeRe(home)}/\\.tmp/claude-\\d+/`, "g");
  const cwd = new RegExp(`${escapeRe(home)}/workspace/usage-sandbox`, "g");
  const slug = new RegExp(escapeRe(home.replace(/[^A-Za-z0-9]/g, "-") + "-workspace-usage-sandbox"), "g");
  const homeRe = new RegExp(escapeRe(home), "g");
  const userRe = new RegExp(`\\b${escapeRe(user)}\\b`, "g");
  return (text) =>
    text
      .replace(tmp, "/tmp/claude-fixture/")
      .replace(slug, FIXTURE_SLUG)
      .replace(cwd, FIXTURE_CWD)
      .replace(homeRe, FIXTURE_HOME)
      .replace(userRe, "fixture-user");
}

/** Anything matching is a reason to refuse: a scrub that missed something. */
export function privacyProblems(text, home, user) {
  const problems = [];
  const literal = [home, user].filter((s) => s && s.length > 2);
  for (const s of literal) if (text.includes(s)) problems.push(`contains "${s}"`);
  if (/[\w.+-]+@[\w-]+\.[a-z]{2,}/i.test(text)) problems.push("contains an email address");
  if (/organizationUuid|accountUuid|"userId"/.test(text)) problems.push("contains account identifiers");
  if (/\/\.tmp\/|claude-\d{3,}/.test(text)) problems.push("contains a temp path");
  return problems;
}

const isKept = (e) => {
  if (DROP_TYPES.has(e.type)) return false;
  if (e.type === "attachment") return KEEP_ATTACHMENTS.has(e.attachment?.type);
  return true;
};

/** Drop lines and re-point `parentUuid` / `logicalParentUuid` / `leafUuid` at the nearest kept ancestor. */
export function trimEntries(entries) {
  const byUuid = new Map(entries.filter((e) => typeof e.uuid === "string").map((e) => [e.uuid, e]));
  const kept = new Set(entries.filter(isKept));
  const nearestKept = (uuid) => {
    const seen = new Set();
    let cur = uuid ? byUuid.get(uuid) : undefined;
    while (cur && !kept.has(cur) && !seen.has(cur.uuid)) {
      seen.add(cur.uuid);
      cur = cur.parentUuid ? byUuid.get(cur.parentUuid) : undefined;
    }
    return cur && kept.has(cur) ? cur.uuid : null;
  };
  const out = [];
  for (const e of entries) {
    if (!kept.has(e)) continue;
    const copy = { ...e };
    if (copy.parentUuid) copy.parentUuid = nearestKept(copy.parentUuid);
    if (copy.logicalParentUuid) copy.logicalParentUuid = nearestKept(copy.logicalParentUuid);
    if (copy.leafUuid) copy.leafUuid = nearestKept(copy.leafUuid);
    out.push(copy);
  }
  return out;
}

/** Thinking signatures are large opaque blobs the adapter never reads. */
function shortenSignatures(value) {
  if (Array.isArray(value)) return value.forEach(shortenSignatures);
  if (!value || typeof value !== "object") return;
  for (const [k, v] of Object.entries(value)) {
    if (k === "signature" && typeof v === "string" && v.length > SIGNATURE.length) value[k] = SIGNATURE;
    else shortenSignatures(v);
  }
}

function sanitizeJsonl(raw, scrub) {
  const entries = raw.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const trimmed = trimEntries(entries);
  shortenSignatures(trimmed);
  return trimmed.map((e) => scrub(JSON.stringify(e))).join("\n") + "\n";
}

function main() {
  const [src, out, ...prefixes] = process.argv.slice(2);
  if (!src || !out) {
    console.error("usage: sanitize-claude-fixtures.mjs <project-dir> <out-dir> [session-id-prefix...]");
    process.exit(2);
  }
  const home = homedir();
  const user = userInfo().username;
  const scrub = makeScrub(home, user);
  const ids = readdirSync(src)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => f.slice(0, -".jsonl".length))
    .filter((id) => prefixes.length === 0 || prefixes.some((p) => id.startsWith(p)));

  const target = join(out, FIXTURE_SLUG);
  mkdirSync(target, { recursive: true });
  let files = 0;
  let bytes = 0;
  const write = (path, text) => {
    const problems = privacyProblems(text, home, user);
    if (problems.length) throw new Error(`${path}: ${problems.join("; ")}`);
    writeFileSync(path, text);
    files += 1;
    bytes += text.length;
  };

  for (const id of ids) {
    write(join(target, `${id}.jsonl`), sanitizeJsonl(readFileSync(join(src, `${id}.jsonl`), "utf8"), scrub));
    const subDir = join(src, id, "subagents");
    if (!existsSync(subDir)) continue;
    const outSub = join(target, id, "subagents");
    mkdirSync(outSub, { recursive: true });
    for (const f of readdirSync(subDir).sort()) {
      const raw = readFileSync(join(subDir, f), "utf8");
      if (f.endsWith(".jsonl")) write(join(outSub, f), sanitizeJsonl(raw, scrub));
      else if (f.endsWith(".meta.json")) write(join(outSub, f), scrub(raw));
    }
  }
  console.log(`${ids.length} sessions, ${files} files, ${bytes} bytes → ${target}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
