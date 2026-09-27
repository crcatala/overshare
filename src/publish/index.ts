import type { AgentShareConfig, ShareTarget } from "../config.js";
import { GistPublisher } from "./gist.js";
import { R2Publisher, r2CredentialsFromEnv } from "./r2.js";
import type { Publisher } from "./types.js";

export function createPublisher(config: AgentShareConfig, target: ShareTarget, env: NodeJS.ProcessEnv = process.env): Publisher {
  if (target === "gist") return new GistPublisher({ viewerUrl: config.viewerUrl });
  if (!config.r2) throw new Error('target "r2" needs an "r2" section in the agent-share config (bucket, publicUrl, accountId)');
  const credentials = r2CredentialsFromEnv(env);
  if (!credentials) throw new Error("R2 credentials missing: set AGENT_SHARE_R2_ACCESS_KEY_ID and AGENT_SHARE_R2_SECRET_ACCESS_KEY");
  return new R2Publisher({ config: config.r2, credentials, viewerUrl: config.viewerUrl });
}

export type ShareRef = { target: ShareTarget; id: string };

/**
 * Identify a share from a viewer link, gist URL, or bare id:
 *   …/session/#r2:<id>, #owner/<gistId>, https://gist.github.com/owner/<id>, <gistId>, r2:<id>
 */
export function parseShareRef(input: string, fallback: ShareTarget = "gist"): ShareRef {
  const hash = input.includes("#") ? input.slice(input.indexOf("#") + 1).split("&")[0]! : input;
  const r2 = /^r2:([A-Za-z0-9_-]+)$/.exec(hash);
  if (r2) return { target: "r2", id: r2[1]! };
  const gist = /(?:gist\.github\.com\/(?:[^/]+\/)?|^[\w-]+\/|^gist:)?([0-9a-f]{20,})$/i.exec(hash);
  if (gist) return { target: "gist", id: gist[1]! };
  if (/^[A-Za-z0-9_-]{8,128}$/.test(hash)) return { target: fallback, id: hash };
  throw new Error(`Not a share link or id: ${input}`);
}
