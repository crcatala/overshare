import { randomBytes } from "node:crypto";
import { AwsClient } from "aws4fetch";
import type { PublishPayload, PublishResult, Publisher } from "./types.js";

/**
 * Public Cloudflare R2 bucket as share storage. No backend is involved: the CLI
 * uploads with your own R2 API token (S3-compatible API), and the viewer reads the
 * object straight from the bucket's public URL. Shares are unlisted because ids are
 * random (128 bits) and public R2 buckets do not allow listing.
 */
export interface R2Config {
  /** Cloudflare account id (used to build the S3 endpoint). */
  accountId?: string;
  bucket: string;
  /** Key prefix, e.g. "s/". */
  prefix?: string;
  /** Public base URL of the bucket: a custom domain or the r2.dev URL. */
  publicUrl: string;
  /** Override the S3 endpoint (tests, other S3-compatible stores). */
  endpoint?: string;
}

export interface R2Credentials {
  accessKeyId: string;
  secretAccessKey: string;
}

/** Name of the viewer source that R2 shares use in links: `#r2:<id>`. */
export const R2_SOURCE = "r2";

export function r2CredentialsFromEnv(env: NodeJS.ProcessEnv = process.env): R2Credentials | undefined {
  const accessKeyId = env.AGENT_SHARE_R2_ACCESS_KEY_ID ?? env.R2_ACCESS_KEY_ID;
  const secretAccessKey = env.AGENT_SHARE_R2_SECRET_ACCESS_KEY ?? env.R2_SECRET_ACCESS_KEY;
  return accessKeyId && secretAccessKey ? { accessKeyId, secretAccessKey } : undefined;
}

export function newShareId(): string {
  return randomBytes(16).toString("base64url");
}

export function r2ObjectKey(config: R2Config, id: string): string {
  return `${config.prefix ?? ""}${id}.json`;
}

export function r2PublicUrl(config: R2Config, id: string): string {
  return `${config.publicUrl.replace(/\/+$/, "")}/${r2ObjectKey(config, id)}`;
}

/** The `sources.r2` template the viewer must be built with (viewer.config.json). */
export function r2SourceTemplate(config: R2Config): string {
  return r2PublicUrl(config, "{id}");
}

function endpoint(config: R2Config): string {
  if (config.endpoint) return config.endpoint.replace(/\/+$/, "");
  if (!config.accountId) throw new Error("r2.accountId (or r2.endpoint) is required in the agent-share config");
  return `https://${config.accountId}.r2.cloudflarestorage.com`;
}

export class R2Publisher implements Publisher {
  readonly name = "r2";
  private readonly client: AwsClient;

  constructor(
    private readonly opts: { config: R2Config; credentials: R2Credentials; viewerUrl: string; fetch?: typeof fetch },
  ) {
    this.client = new AwsClient({ ...opts.credentials, service: "s3", region: "auto" });
  }

  private objectUrl(id: string): string {
    const key = r2ObjectKey(this.opts.config, id).split("/").map(encodeURIComponent).join("/");
    return `${endpoint(this.opts.config)}/${encodeURIComponent(this.opts.config.bucket)}/${key}`;
  }

  private async send(url: string, init: RequestInit): Promise<Response> {
    const request = await this.client.sign(url, init);
    return (this.opts.fetch ?? fetch)(request);
  }

  async publish(payload: PublishPayload): Promise<PublishResult> {
    const id = newShareId();
    const res = await this.send(this.objectUrl(id), {
      method: "PUT",
      body: payload.content,
      headers: {
        "content-type": "application/json; charset=utf-8",
        // Short cache so a deleted share disappears from the edge reasonably quickly.
        "cache-control": "public, max-age=300",
      },
    });
    if (!res.ok) throw new Error(`R2 upload failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
    const publicUrl = r2PublicUrl(this.opts.config, id);
    return { publisher: this.name, id, url: publicUrl, rawUrl: publicUrl, viewerUrl: `${this.opts.viewerUrl}#${R2_SOURCE}:${id}` };
  }

  async delete(id: string): Promise<void> {
    const res = await this.send(this.objectUrl(id), { method: "DELETE" });
    if (!res.ok && res.status !== 404) throw new Error(`R2 delete failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  }
}

export interface PublicAccessCheck {
  status: number;
  /** The viewer's origin is allowed by the bucket's CORS policy. */
  cors: boolean;
}

/** Fetch the uploaded object like the viewer would, to catch missing public access or CORS. */
export async function checkPublicAccess(publicUrl: string, viewerOrigin: string, doFetch: typeof fetch = fetch): Promise<PublicAccessCheck> {
  const res = await doFetch(publicUrl, { headers: { Origin: viewerOrigin } });
  const allow = res.headers.get("access-control-allow-origin");
  await res.body?.cancel();
  return { status: res.status, cors: allow === "*" || allow === viewerOrigin };
}
