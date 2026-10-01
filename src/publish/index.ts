import type { AgentShareConfig, ShareTarget } from "../config.js";
import { formatTokens } from "../format.js";
import type { PreparedShare } from "../pipeline.js";
import { totalTokens } from "../schema.js";
import { recordShare, removeShares } from "../sessions/shares.js";
import { GistPublisher } from "./gist.js";
import { R2Publisher, checkPublicAccess, r2CredentialsFromEnv, r2PublicUrl } from "./r2.js";
import type { PublishResult, Publisher } from "./types.js";

export function createPublisher(config: AgentShareConfig, target: ShareTarget, env: NodeJS.ProcessEnv = process.env): Publisher {
  if (target === "gist") return new GistPublisher({ viewerUrl: config.viewerUrl });
  if (!config.r2) throw new Error('target "r2" needs an "r2" section in the agent-share config (bucket, publicUrl, accountId)');
  const credentials = r2CredentialsFromEnv(env);
  if (!credentials) throw new Error("R2 credentials missing: set AGENT_SHARE_R2_ACCESS_KEY_ID and AGENT_SHARE_R2_SECRET_ACCESS_KEY");
  return new R2Publisher({ config: config.r2, credentials, viewerUrl: config.viewerUrl });
}

/** Problems that make a share unviewable, detectable before uploading. */
export function preflightWarnings(config: AgentShareConfig, target: ShareTarget): string[] {
  if (target === "r2" && config.viewerUrlSource === "default") {
    return [
      `viewerUrl is the built-in default (${config.viewerUrl}); R2 links only open in a viewer built with your "r2" source in viewer.config.json — set viewerUrl in the agent-share config to your own deployment`,
    ];
  }
  return [];
}

/** After an R2 upload, fetch the object like the viewer would to catch missing public access or CORS. */
export async function accessWarnings(config: AgentShareConfig, target: ShareTarget, result: PublishResult, doFetch: typeof fetch = fetch): Promise<string[]> {
  if (target !== "r2" || !result.rawUrl) return [];
  const origin = new URL(config.viewerUrl).origin;
  try {
    const check = await checkPublicAccess(result.rawUrl, origin, doFetch);
    if (check.status !== 200) return [`public URL returned ${check.status} — is public access enabled on the bucket, and does r2.publicUrl match it?`];
    if (!check.cors) return [`the bucket's CORS policy does not allow ${origin}; the viewer will not be able to load it (see README "Storage targets")`];
  } catch (err) {
    return [`could not verify the public URL: ${(err as Error).message}`];
  }
  return [];
}

/**
 * Upload a prepared (redacted, re-scanned) share and remember it in `shares.json`.
 * Shared by `agent-share publish` and the `browse` TUI, so both publish exactly the same way.
 * Refusing blocked or unconfirmed shares is the caller's job; this only uploads.
 */
export async function publishPrepared(
  publisher: Publisher,
  config: AgentShareConfig,
  target: ShareTarget,
  prepared: PreparedShare,
): Promise<{ result: PublishResult; warnings: string[] }> {
  const s = prepared.session;
  const result = await publisher.publish({
    filename: "session.json",
    content: prepared.json,
    description: `agent-share: ${s.title ?? s.source.sessionId} (${s.harness.name}, ${s.mode}, ${formatTokens(totalTokens(s.stats.tokens))} tokens)`,
  });
  const warnings = await accessWarnings(config, target, result);
  const recorded = recordShare(s.harness.name, s.source.sessionId, { url: result.viewerUrl, mode: s.mode, target, sharedAt: new Date().toISOString() });
  if (!recorded) warnings.push("could not record this share in shares.json, so the browser will not mark it as shared");
  return { result, warnings };
}

/**
 * Forget a deleted share in `shares.json` so the browser stops marking its session as shared.
 * Records store the viewer link, so each is matched by parsing it like user input. Returns false
 * (the caller warns) only when the file could not be read or updated; an unrecorded share is fine.
 */
export function forgetShare(ref: ShareRef, path?: string): boolean {
  return removeShares((record) => {
    try {
      const recorded = parseShareRef(record.url, record.target);
      return recorded.target === ref.target && recorded.id === ref.id;
    } catch {
      return false;
    }
  }, path);
}

export type ShareRef = { target: ShareTarget; id: string };

const R2_ID = "[A-Za-z0-9_-]{8,128}";
const GIST_ID = "[0-9a-f]{20,40}";

/**
 * Identify a share from anything `publish` prints, parsed strictly because `delete` is
 * destructive:
 *   viewer links   …/session/#r2:<id>, …/session/#<owner>/<gistId>, …#gist:<gistId>
 *   gist URLs      https://gist.github.com/[<owner>/]<id>, https://gist.githubusercontent.com/<owner>/<id>/raw/…
 *   R2 data URLs   <r2.publicUrl>/<r2.prefix><id>.json
 *   bare           r2:<id>, gist:<gistId>, a 20/32-hex gist id, or <id> when `fallback` is r2
 */
export function parseShareRef(input: string, fallback: ShareTarget = "gist", r2?: AgentShareConfig["r2"]): ShareRef {
  const value = input.trim();
  const match = (re: string) => new RegExp(`^${re}$`, "i").exec(value);
  const hash = value.includes("#") ? value.slice(value.indexOf("#") + 1).split("&")[0]! : undefined;
  if (hash !== undefined) {
    const r2Hash = new RegExp(`^r2:(${R2_ID})$`).exec(hash);
    if (r2Hash) return { target: "r2", id: r2Hash[1]! };
    const gistHash = new RegExp(`^(?:gist:|[\\w-]+\\/)?(${GIST_ID})$`, "i").exec(hash);
    if (gistHash) return { target: "gist", id: gistHash[1]! };
    throw new Error(`Not a share link: ${input}`);
  }
  const gistUrl = match(`https://gist\\.github(?:usercontent)?\\.com/(?:[\\w-]+/)?(${GIST_ID})(?:/.*)?`);
  if (gistUrl) return { target: "gist", id: gistUrl[1]! };
  if (r2) {
    // <publicUrl>/<prefix><id>.json — the "Data:" URL printed by `publish --target r2`.
    const base = r2PublicUrl(r2, "").replace(/\.json$/, "");
    const rest = value.startsWith(base) ? new RegExp(`^(${R2_ID})\\.json$`).exec(value.slice(base.length)) : null;
    if (rest) return { target: "r2", id: rest[1]! };
  }
  const bareR2 = match(`r2:(${R2_ID})`);
  if (bareR2) return { target: "r2", id: bareR2[1]! };
  const bareGist = match(`(?:gist:)?(${GIST_ID})`);
  if (bareGist && (value.startsWith("gist:") || /^[0-9a-f]{20}$|^[0-9a-f]{32}$/i.test(value))) return { target: "gist", id: bareGist[1]! };
  // Bare ids are only guessed for R2 (random base64url); gist ids must be gist-shaped.
  if (fallback === "r2" && new RegExp(`^${R2_ID}$`).test(value)) return { target: "r2", id: value };
  throw new Error(`Not a share link or id: ${input}`);
}
