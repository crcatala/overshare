/**
 * The index holds prompt text copied out of Claude Code's private (0700) project directories, and
 * `shares.json` holds unlisted share links, which work as capabilities. Neither should be readable by
 * other users of the machine. `mkdir`/`writeFile` modes only apply to what they create, and both files
 * are replaced by rename, so a file that exists with looser permissions is fixed the next time it is saved.
 */
export const PRIVATE_DIR_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;
