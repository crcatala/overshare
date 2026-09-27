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
 * A storage backend for share payloads. Implementations: `gist` (now); R2 later
 * (`agent.nub.sh`), which only needs to store `session.json` under an unguessable
 * id and return a viewer URL the viewer knows how to load.
 */
export interface Publisher {
  readonly name: string;
  publish(payload: PublishPayload): Promise<PublishResult>;
}

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (command: string, args: string[]) => Promise<CommandResult>;
