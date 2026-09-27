export interface PublishPayload {
  /** File name inside the share (the viewer loads `session.json`). */
  filename: string;
  content: string;
  description: string;
}

export interface PublishResult {
  publisher: string;
  id: string;
  /** Where the stored payload lives (e.g. the gist page). */
  url: string;
  /** Link to open in the viewer. */
  viewerUrl: string;
  rawUrl?: string;
}

/**
 * Where share payloads are stored. Storage is always public-by-link and static:
 * `gist` (secret GitHub gist) and `r2` (public Cloudflare R2 bucket). A publisher
 * stores `session.json` under an unguessable id and returns a viewer URL.
 */
export interface Publisher {
  readonly name: string;
  publish(payload: PublishPayload): Promise<PublishResult>;
  /** Remove a previously published share by id. */
  delete(id: string): Promise<void>;
}

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (command: string, args: string[]) => Promise<CommandResult>;
