import type { Rng } from "./random.js";

/**
 * Fake credentials planted in fixtures. Each has the real format of its provider so
 * the detectors fire, but is random (never "obviously fake", which the redactor
 * deliberately ignores). Values are generated at runtime: nothing secret-shaped is
 * committed to the repository.
 */
export interface PlantedSecret {
  label: string;
  value: string;
  /** How the redactor is expected to catch it. */
  caughtBy: "pattern" | "assignment" | "secrets-file";
}

const UPPER32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

const b64url = (s: string) => Buffer.from(s).toString("base64url");

export interface FixtureSecrets {
  list: PlantedSecret[];
  byLabel: Record<string, string>;
}

export function plantSecrets(rng: Rng): FixtureSecrets {
  const digits = (n: number) => rng.token(n, "0123456789");
  const jwt = [
    b64url(JSON.stringify({ alg: "HS256", typ: "JWT" })),
    b64url(JSON.stringify({ sub: `usr_${rng.token(12)}`, role: "admin", iat: 1767225600 + rng.int(0, 1e6) })),
    rng.token(43, B64URL),
  ].join(".");
  // Marker split so the source itself never contains a private-key header.
  const marker = ["RSA PRIVATE", "KEY-----"].join(" ");
  const pem = [`-----BEGIN ${marker}`, ...Array.from({ length: 6 }, () => rng.token(64, B64)), `-----END ${marker}`].join("\n");
  const dbPassword = `Pg${rng.token(18)}9`;
  const list: PlantedSecret[] = [
    { label: "GITHUB_TOKEN", value: `ghp_${rng.token(36)}`, caughtBy: "pattern" },
    { label: "ANTHROPIC_API_KEY", value: `sk-ant-api03-${rng.token(93, B64URL)}AA`, caughtBy: "pattern" },
    { label: "AWS_ACCESS_KEY_ID", value: `AKIA${rng.token(16, UPPER32)}`, caughtBy: "pattern" },
    { label: "AWS_SECRET_ACCESS_KEY", value: rng.token(40, B64), caughtBy: "assignment" },
    { label: "STRIPE_SECRET_KEY", value: `sk_live_${rng.token(24)}`, caughtBy: "pattern" },
    { label: "SLACK_BOT_TOKEN", value: `xoxb-${digits(12)}-${digits(13)}-${rng.token(24)}`, caughtBy: "pattern" },
    { label: "DB_PASSWORD", value: dbPassword, caughtBy: "assignment" },
    { label: "DATABASE_URL_PASSWORD", value: `Rw${rng.token(16)}7`, caughtBy: "pattern" },
    { label: "SESSION_JWT", value: jwt, caughtBy: "pattern" },
    { label: "DEPLOY_KEY", value: pem, caughtBy: "pattern" },
    // No public format: only the known-values layer (--secrets-file) can catch this one.
    { label: "ACME_INTERNAL_TOKEN", value: `acmeint.${rng.hex(8)}.${rng.token(10, "abcdefghjkmnpqrstuvwxyz")}`, caughtBy: "secrets-file" },
  ];
  return { list, byLabel: Object.fromEntries(list.map((s) => [s.label, s.value])) };
}

/** `KEY=VALUE` lines for `--secrets-file` (multi-line values like PEM keys are left to the patterns). */
export function secretsEnvFile(secrets: FixtureSecrets): string {
  return `${secrets.list
    .filter((s) => !s.value.includes("\n"))
    .map((s) => `${s.label}=${s.value}`)
    .join("\n")}\n`;
}
