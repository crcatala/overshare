import { shannonEntropy } from "@sanity-labs/secret-scan";
import type { PatternMatch } from "./patterns.js";

/**
 * Provider token formats recognised by their own shape, with no surrounding context needed: a literal prefix the
 * provider chose (`vcp_`, `glrt-`, `sk-or-v1-`) followed by a random body. Written by hand from the providers' public
 * token formats to cover what the generic detector (`@sanity-labs/secret-scan`, a frozen snapshot of TruffleHog's
 * detectors) misses when a token is printed bare, e.g. in tool output.
 *
 * Choices that apply to every entry:
 * - Lengths are lower bounds (`{40,}`), not the provider's exact length. Providers lengthen tokens over time and an
 *   exact length turns every such change into a silent miss (and a longer token is redacted only up to the old
 *   length, leaving its tail), while the distinctive prefix already keeps false positives rare. A match runs to the
 *   end of the token's character class. What stays fixed is structure, not length: the segments and separators of
 *   a multi-part token (`pat<14>.<hex>`, `glsa_<id>_<hex>`, a UUID) and a Discord token's three dotted parts.
 * - A body must look random (`plausibleBody`): snake_case identifiers and prose that merely start with a prefix
 *   (`napi_create_function`, `rnd_state_vector`) are left alone. Placeholder runs like `xxxxxxxx` are dropped by the
 *   caller's `isObviouslyFake`.
 * - `ambiguous` entries have a prefix short or common enough to occur outside credentials. They must not sit inside a
 *   longer identifier (`my_re_…`) and are reported at medium confidence (redacted, but they never block the final
 *   re-scan on their own).
 * - Only secrets are listed. Public identifiers (Stripe `pk_`, PostHog `phc_`, Twilio account SIDs, Sentry DSN public
 *   keys) are not.
 *
 * Betterleaks (MIT, https://github.com/betterleaks/betterleaks) was used as a checklist of which providers have a
 * recognisable format; none of its code or regexes is copied.
 */
interface TokenFormat {
  rule: string;
  /** Literal that must occur in the text for the format to be tried: one `includes` instead of a regex scan per format. */
  hint: string;
  re: RegExp;
  ambiguous: boolean;
  /** Skip `plausibleBody`: the shape is distinctive enough, or the match has no random body to judge. */
  plain: boolean;
}

interface Options {
  ambiguous?: boolean;
  plain?: boolean;
  /** The pattern carries its own lookbehind; do not prepend the "not inside a longer word" one. */
  anchored?: boolean;
}

/** A token directly after letters or digits is part of some longer string; ambiguous prefixes also exclude `_` and `-`. */
const AFTER_WORD = "(?<![A-Za-z0-9])";
const AFTER_IDENT = "(?<![A-Za-z0-9_-])";

function fmt(rule: string, hint: string, source: string, o: Options = {}): TokenFormat {
  const guard = o.anchored ? "" : o.ambiguous ? AFTER_IDENT : AFTER_WORD;
  return { rule, hint, re: new RegExp(`${guard}(?:${source})`, "g"), ambiguous: !!o.ambiguous, plain: !!o.plain };
}

const r = String.raw;

export const TOKEN_FORMATS: readonly TokenFormat[] = [
  // Source hosting and CI. GitLab's family shares `gl<kind>-`; routable tokens add a `.01.<id>` tail.
  fmt("gitlab-token", "gl", r`gl(?:pat|dt|rt|ptt|ft|imt|agent|oas|soat|ffct|cbt)-[A-Za-z0-9_-]{20,}(?:\.[0-9a-z]{2}\.[0-9a-z]{6,})?`),
  fmt("circleci-token", "CCI", r`CCI(?:PAT|PRJ)_[A-Za-z0-9]{10,}_[A-Za-z0-9]{36,}`),
  fmt("buildkite-token", "bk", r`bk(?:ua|aa|ct)_[A-Za-z0-9_-]{36,}`),
  fmt("rubygems-token", "rubygems_", r`rubygems_[0-9a-f]{48,}`),
  fmt("clojars-token", "CLOJARS_", r`CLOJARS_[a-z0-9]{40,}`),
  fmt("docker-swarm-token", "SWM", r`SWM(?:TKN|KEY)-1-[A-Za-z0-9-]{40,}`),
  fmt("gitlab-runner-registration", "GR1348941", r`GR1348941[A-Za-z0-9_-]{20,}`),
  fmt("netlify-token", "nfp_", r`nfp_[A-Za-z0-9]{30,}`),
  fmt("airtable-token", "pat", r`pat[A-Za-z0-9]{14}\.[0-9a-f]{64,}`, { plain: true }),

  // Hosting, databases and infrastructure.
  fmt("vercel-token", "vc", r`vc[piark]_[A-Za-z0-9]{24,}`),
  fmt("supabase-token", "sb", r`sbp_[A-Za-z0-9_-]{36,}|sb_secret_[A-Za-z0-9_-]{20,}`),
  fmt("neon-key", "napi_", r`napi_[A-Za-z0-9]{40,}`),
  fmt("render-key", "rnd_", r`rnd_[A-Za-z0-9]{24,}`, { ambiguous: true }),
  fmt("pulumi-token", "pul-", r`pul-[0-9a-f]{40,}`),
  fmt("databricks-token", "dapi", r`dapi[0-9a-f]{32,}(?:-\d)?`),
  fmt("planetscale-token", "pscale_", r`pscale_(?:tkn|pw|oauth)_[A-Za-z0-9_.-]{32,}`),
  fmt("shopify-token", "shp", r`shp(?:at|ca|pa|ss)_[0-9a-fA-F]{32,}`),
  fmt("sentry-token", "sntry", r`sntry[su]_[A-Za-z0-9+/=_-]{40,}`),
  fmt("tailscale-key", "tskey-", r`tskey-(?:api|auth|client|scim|webhook)-[A-Za-z0-9]+-[A-Za-z0-9]{20,}`),
  fmt("vault-token", "hv", r`hv[sbr]\.[A-Za-z0-9_-]{24,}`),
  fmt("terraform-cloud-token", ".atlasv1.", r`[A-Za-z0-9]{14}\.atlasv1\.[A-Za-z0-9_=-]{60,}`, { plain: true }),
  fmt("grafana-token", "gl", r`glc_[A-Za-z0-9+/=]{50,}|glsa_[A-Za-z0-9]{32,}_[0-9a-f]{8,}`),
  fmt("dynatrace-token", "dt0c01.", r`dt0c01\.[A-Za-z0-9]{24}\.[A-Za-z0-9]{64,}`, { plain: true }),
  fmt("heroku-token", "HRKU-", r`HRKU-[A-Za-z0-9_-]{30,}`),
  fmt("doppler-token", "dp.", r`dp\.(?:pt|st|sa|ct|scim|audit)\.(?:[a-z0-9_-]{1,40}\.)?[A-Za-z0-9]{40,}`),
  fmt("atlassian-token", "ATATT3", r`ATATT3[A-Za-z0-9_=-]{50,}`),
  fmt("aws-bedrock-key", "ABSK", r`ABSK[A-Za-z0-9+/=]{80,}`, { plain: true }),
  fmt("aws-bedrock-key", "bedrock-api-key-", r`bedrock-api-key-[A-Za-z0-9+/=_-]{24,}`, { plain: true }),
  fmt("azure-storage-key", "AccountKey=", r`(?<=AccountKey=)[A-Za-z0-9+/]{80,}={0,2}`, { anchored: true, plain: true }),
  fmt("polar-token", "polar_", r`polar_(?:at|oat|pat|ot)_[A-Za-z0-9]{30,}`),

  // AI providers and tooling.
  fmt("openrouter-key", "sk-or-", r`sk-or-v1-[0-9a-f]{48,}`),
  fmt("perplexity-key", "pplx-", r`pplx-[A-Za-z0-9]{40,}`),
  fmt("cerebras-key", "csk-", r`csk-[a-z0-9]{40,}`),
  fmt("together-key", "tgp_v1_", r`tgp_v1_[A-Za-z0-9_-]{30,}`),
  fmt("langsmith-key", "lsv2_", r`lsv2_(?:pt|sk)_[A-Za-z0-9]{32,}(?:_[A-Za-z0-9]{10,})?`),
  fmt("langfuse-key", "sk-lf-", r`sk-lf-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}`),
  fmt("wandb-key", "wandb_v1_", r`wandb_v1_[A-Za-z0-9_]{40,}`),
  fmt("nvidia-key", "nvapi-", r`nvapi-[A-Za-z0-9_-]{50,}`),
  fmt("pinecone-key", "pcsk_", r`pcsk_[A-Za-z0-9_]{40,}`),

  // Google. The API key shape is also Firebase's and Gemini's.
  fmt("google-api-key", "AIza", r`AIza[A-Za-z0-9_-]{35,}`),
  fmt("google-oauth-secret", "GOCSPX-", r`GOCSPX-[A-Za-z0-9_-]{28,}`),
  fmt("google-oauth-token", "ya29.", r`ya29\.[A-Za-z0-9_-]{40,}`),
  fmt("google-refresh-token", "1//0", r`(?<![A-Za-z0-9/])1//0[A-Za-z0-9_-]{40,}`, { anchored: true }),
  fmt("firebase-server-key", ":APA91b", r`AAAA[A-Za-z0-9_-]{7}:APA91b[A-Za-z0-9_-]{100,}`, { plain: true }),

  // SaaS APIs.
  fmt("notion-token", "ntn_", r`ntn_[A-Za-z0-9]{40,}`),
  fmt("figma-token", "figd_", r`figd_[A-Za-z0-9_-]{40,}`),
  fmt("posthog-personal-key", "phx_", r`phx_[A-Za-z0-9]{40,}`),
  fmt("pypi-token", "pypi-AgE", r`pypi-AgE[A-Za-z0-9_-]{70,}`),
  fmt("slack-app-token", "xapp-", r`xapp-\d-[A-Z0-9]{8,}-\d{8,}-[0-9a-f]{32,}`),
  fmt("slack-config-token", "xoxe", r`xoxe(?:\.xox[bp])?-\d-[A-Za-z0-9]{80,}`),
  fmt("slack-session-token", "xox", r`xoxc-\d+-\d+-\d+-[0-9a-f]{32,}|xoxd-[A-Za-z0-9%+/=_-]{40,}`),
  fmt("resend-key", "re_", r`re_[A-Za-z0-9]{6,12}_[A-Za-z0-9]{20,}`, { ambiguous: true }),
  fmt("twilio-key", "SK", r`SK[0-9a-f]{32,}`, { ambiguous: true }),
  fmt("discord-bot-token", ".", r`[MNO][A-Za-z0-9_-]{23,25}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}`, { ambiguous: true }),
  fmt("telegram-bot-token", ":AA", r`\d{8,10}:AA[A-Za-z0-9_-]{33,}`, { ambiguous: true }),
];

/** A body of a random token has a digit or both letter cases, and enough variety; prose and identifiers do not. */
function plausibleBody(body: string): boolean {
  const mixed = /\d/.test(body) && /[A-Za-z]/.test(body);
  if (!(mixed || (/[a-z]/.test(body) && /[A-Z]/.test(body)))) return false;
  // 3.0 rejects runs of a few characters and keeps about 99.995% of random 32-character hex (a stricter bar dropped ~2%).
  return shannonEntropy(body) >= 3.0;
}

/**
 * Every format here, and an AWS key id, has at least this many token characters in a row. Most strings in a transcript
 * (prose, short commands) have no such run, and one regex test then replaces the whole table.
 */
const LONG_RUN = /[A-Za-z0-9_+/=.-]{20}/;

/** Matches of the formats above in `text` (overlaps are resolved by the caller). */
export function findTokenFormats(text: string): PatternMatch[] {
  const found: PatternMatch[] = [];
  if (!LONG_RUN.test(text)) return found;
  for (const f of TOKEN_FORMATS) {
    if (f.hint && !text.includes(f.hint)) continue;
    for (const m of text.matchAll(f.re)) {
      if (!f.plain && !plausibleBody(m[0].slice(f.hint.length))) continue;
      found.push({ rule: f.rule, start: m.index, end: m.index + m[0].length, confidence: f.ambiguous ? "medium" : "high" });
    }
  }
  return found;
}

const AWS_KEY_ID = /(?<![A-Za-z0-9])(?:AKIA|ASIA|ABIA|ACCA)[A-Z2-7]{16}(?![A-Za-z0-9])/g;
const AWS_SECRET = /(?<![A-Za-z0-9/+])[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+])/g;
/** How far from an access key id, in lines either way, its secret key is looked for (the pair is printed together). */
const AWS_NEAR_LINES = 5;

/**
 * An AWS secret access key has no prefix: 40 base64 characters. It is recognised by sitting within a few lines of an
 * access key id (`aws configure list`, a credentials file, an `export` pair), whatever its variable is called, which
 * the `secret-assignment` rule alone misses when the name is unusual or absent. A 40-character hex string (a git sha)
 * and low-variety text do not count.
 */
export function findAwsSecretKeys(text: string): PatternMatch[] {
  if (!text.includes("A") || !LONG_RUN.test(text)) return [];
  const found = new Map<number, PatternMatch>();
  for (const id of text.matchAll(AWS_KEY_ID)) {
    // The window runs from `AWS_NEAR_LINES` lines before the id's line to as many after it.
    let lo = text.lastIndexOf("\n", id.index - 1) + 1;
    for (let n = 0; n < AWS_NEAR_LINES && lo > 0; n++) lo = text.lastIndexOf("\n", lo - 2) + 1;
    let hi = text.indexOf("\n", id.index);
    if (hi === -1) hi = text.length;
    for (let n = 0; n < AWS_NEAR_LINES && hi < text.length; n++) {
      const nl = text.indexOf("\n", hi + 1);
      hi = nl === -1 ? text.length : nl;
    }
    for (const m of text.slice(lo, hi).matchAll(AWS_SECRET)) {
      const value = m[0];
      if (/^[0-9a-f]{40}$/i.test(value) || !/[A-Z]/.test(value) || !/[a-z]/.test(value) || !/\d/.test(value) || shannonEntropy(value) < 4) continue;
      const start = lo + m.index;
      found.set(start, { rule: "aws-secret-key", start, end: start + value.length, confidence: "high" });
    }
  }
  return [...found.values()];
}
