import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandRunner, PublishPayload, PublishResult, Publisher } from "./types.js";

export const defaultRunner: CommandRunner = (command, args) =>
  new Promise((resolve) => {
    execFile(command, args, { maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error ? (typeof (error as NodeJS.ErrnoException).code === "number" ? Number((error as NodeJS.ErrnoException).code) : 1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr || (error && !stderr ? error.message : "")) });
    });
  });

/**
 * Publishes to a *secret* GitHub gist via the `gh` CLI. Secret gists are unlisted,
 * not private: anyone with the link can read them, and GitHub keeps revisions, so a
 * leaked value can only be removed by deleting the gist (and rotating the secret).
 */
export class GistPublisher implements Publisher {
  readonly name = "gist";

  constructor(private readonly opts: { viewerUrl: string; run?: CommandRunner }) {}

  async publish(payload: PublishPayload): Promise<PublishResult> {
    const run = this.opts.run ?? defaultRunner;
    const auth = await run("gh", ["auth", "status"]);
    if (auth.code !== 0) throw new Error("GitHub CLI is not logged in (run `gh auth login`), or `gh` is not installed.");

    const dir = mkdtempSync(join(tmpdir(), "agent-share-"));
    try {
      const file = join(dir, payload.filename);
      writeFileSync(file, payload.content, { mode: 0o600 });
      // No --public flag: gists are created secret (unlisted) by default.
      const created = await run("gh", ["gist", "create", "--desc", payload.description, file]);
      if (created.code !== 0) throw new Error(`gh gist create failed: ${created.stderr.trim() || created.stdout.trim()}`);
      const url = created.stdout.trim().split("\n").filter(Boolean).at(-1) ?? "";
      const id = /gist\.github\.com\/(?:[^/\s]+\/)?([0-9a-f]+)/i.exec(url)?.[1];
      if (!id) throw new Error(`Could not parse gist id from gh output: ${created.stdout.trim()}`);
      const ownerResult = await run("gh", ["api", `gists/${id}`, "--jq", ".owner.login"]);
      const owner = ownerResult.code === 0 ? ownerResult.stdout.trim() : "";
      const hash = owner ? `${owner}/${id}` : id;
      return {
        publisher: this.name,
        id,
        url,
        viewerUrl: `${this.opts.viewerUrl}#${hash}`,
        ...(owner ? { rawUrl: `https://gist.githubusercontent.com/${owner}/${id}/raw/${payload.filename}` } : {}),
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  async delete(id: string): Promise<void> {
    const run = this.opts.run ?? defaultRunner;
    const res = await run("gh", ["gist", "delete", id, "--yes"]);
    if (res.code !== 0) throw new Error(`gh gist delete failed: ${res.stderr.trim() || res.stdout.trim()}`);
  }
}
