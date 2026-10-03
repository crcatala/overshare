/**
 * Cutting text that has ALREADY been redacted. Cut first and redact afterwards, and a secret that straddles the cut
 * leaves a prefix that matches no rule and no known value (ass-ahh1, ass-7x3c). So every length cap on text that
 * reaches the payload runs on redacted text, here, and never splits one of the Redactor's replacement tokens.
 * Browser-safe: no imports.
 */

/** The longest replacement token the Redactor writes is `[REDACTED:` + a label of at most 64 characters + `]`. */
const TOKEN_LOOKBACK = 128;
const TOKEN_AT = /\[[^\]\s]*\]/y;

/**
 * Where to cut redacted `text` at `end`: `end`, or the start of the replacement token (`[REDACTED:..]`, `[email]`,
 * `[user]`, ...) that spans it, so the token is dropped whole instead of left as `[REDACTED:gith`.
 */
export function cutPoint(text: string, end: number): number {
  const from = Math.max(0, end - TOKEN_LOOKBACK);
  const open = text.lastIndexOf("[", end - 1);
  if (open < from) return end;
  TOKEN_AT.lastIndex = open;
  const m = TOKEN_AT.exec(text);
  return m && open + m[0].length > end ? open : end;
}

/** Cap an already redacted one-line text at `max` characters, the last being an ellipsis; a token is never split. */
export function capRedacted(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, cutPoint(text, max - 1)).trimEnd()}…`;
}
