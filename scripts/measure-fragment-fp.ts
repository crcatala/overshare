/**
 * ass-uho0 measurement: how often would the fragment backstop fire on ordinary shares, per policy? Counts only:
 * nothing printed here is a value, a fragment or transcript text. Usage: tsx scripts/measure-fragment-fp.ts [--real N]
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fake, randomish } from "../tests/helpers.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { generateFixtures } from "../src/fixtures/index.js";
import { prepareShare } from "../src/pipeline.js";
import { collectKnownSecrets, knownSecret, readSecretsFile, type KnownSecret } from "../src/redact/known-values.js";
import type { FragmentPolicy } from "../src/redact/secret-value.js";
import { defaultRoots, listSessions } from "../src/resolve.js";
import { SHARE_MODES } from "../src/schema.js";
import { HARNESS_NAMES } from "../src/harnesses/index.js";
import { loadSubagentFiles } from "../src/harnesses/claude-code/subagent-files.js";

const POLICIES: FragmentPolicy[] = [];
for (const minValueLength of [16, 24])
  for (const ratio of [0.5, 0.33])
    for (const minFragment of [16, 20])
      for (const minRun of [12, 16, 20])
        for (const minEntropy of [0, 3, 3.5]) POLICIES.push({ minValueLength, ratio, minFragment, maxFragment: 32, minRun, minEntropy, maxWordRatio: 0.4 });
const name = (p: FragmentPolicy) => `v>=${p.minValueLength} r=${p.ratio} f>=${p.minFragment} run>=${p.minRun} h>=${p.minEntropy}`;

/** Every string and key of the payload, decoded, joined: what the re-scan would search. */
function decoded(json: string): string {
  const out: string[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === "string") out.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object")
      for (const [k, x] of Object.entries(v)) {
        out.push(k);
        walk(x);
      }
  };
  walk(JSON.parse(json));
  return out.join("\n");
}

class Tally {
  payloads = 0;
  secretsChecked = 0;
  /** Per policy: payloads with at least one hit, and total hits. */
  blocked = new Map<string, number>();
  hits = new Map<string, number>();
  check(text: string, known: KnownSecret[]): void {
    this.payloads++;
    this.secretsChecked += known.length;
    for (const p of POLICIES) {
      let h = 0;
      for (const k of known) if (k.value.hasFragmentIn(text, p)) h++;
      this.hits.set(name(p), (this.hits.get(name(p)) ?? 0) + h);
      if (h) this.blocked.set(name(p), (this.blocked.get(name(p)) ?? 0) + 1);
    }
  }
}

const machine = { homeDir: "/home/tester", username: "tester", hostname: "box" };
const share = (raw: string, knownSecrets: KnownSecret[], mode: (typeof SHARE_MODES)[number], extra: { subagentFiles?: ReturnType<typeof loadSubagentFiles>; machine?: typeof machine } = {}) =>
  prepareShare(raw, { mode, config: DEFAULT_CONFIG, knownSecrets, machine: extra.machine ?? machine, subagentFiles: extra.subagentFiles });

// 1. Fake fixture sessions: every mode, several seeds, the planted secrets as known values.
const fixtures = new Tally();
const dir = mkdtempSync(join(tmpdir(), "uho0-"));
try {
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    const fx = generateFixtures({ outDir: join(dir, String(seed)), seed, extraTurns: seed * 10, home: machine.homeDir, username: machine.username });
    const known = readSecretsFile(fx.secretsFile);
    for (const file of [fx.claudeFile, fx.piFile]) {
      const raw = readFileSync(file, "utf8");
      for (const mode of SHARE_MODES) fixtures.check(decoded(share(raw, known, mode).json), known);
    }
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

// 2. Real-shaped known values (fake): URL/DSN/webhook/path-ish values whose start or end is ordinary text, in a payload that mentions that text.
const shaped = new Tally();
/** [name, ordinary start, secret middle, ordinary end]: the start and end are text a transcript legitimately contains. */
const PARTS: Array<[string, string, string, string]> = [
  ["DATABASE_URL", "postgres://app_user:", "Xk3mQ9vTz2LpW7", "@db.internal.example.com:5432/appdb"],
  ["REDIS_URL", "redis://default:", "aB3dE5gH7jK9mN1pQ3", "@cache.example.com:6379/0"],
  ["SLACK_WEBHOOK", "https://hooks.slack.com/services/", "T01ABCDEF/B02GHIJKL/xY7zA1bC3dE5fG7hI9jK2lM4", ""],
  ["SENTRY_DSN", "https://", "a1b2c3d4e5f60718293a4b5c6d7e8f90", "@o123456.ingest.sentry.io/4501234"],
  ["API_BASE_TOKEN", "Authorization: Bearer ", "pQ4rS6tU8vW0xY2zA4bC6dE8", ""],
  ["S3_URL", "s3://prod-backups-bucket/exports/2026/", "Zk4Lm8Np2Qr6St0U", ""],
  ["MONGO_URI", "mongodb+srv://svc:", "Hj5Kl9Mn3Pq7Rs1T", "@cluster0.abcde.mongodb.net/prod?retryWrites=true"],
  ["JWT_SECRET", "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.", "eyJzdWIiOiIxMjM0NTY3ODkwIn0.Dq8Wf2Ns6Yt0Vh4Bk8Mj2Lp6", ""],
  ["HEX_KEY", "", "0123456789abcdef0123456789abcdef", ""],
  ["STRIPE_KEY", "sk_live_", "51HqRt7UvXy2ZaBc4DeFg6HiJk8LmNo0", ""],
  ["FILE_PATH_VALUE", "/var/lib/app/releases/current/config/", "k9Xv2Lq7Wm4Zt1Rb", "/settings.json"],
  ["PREFIXED_ID", "arn:aws:iam::123456789012:role/", "ServiceRoleQ9x2Lm7Wv4Zt", ""],
];
const SHAPES: Array<[string, string]> = PARTS.map(([n, a, m, z]) => [n, a + m + z]);
const shapedKnown = SHAPES.map(([n, v]) => knownSecret(v, n, "env"));
for (const mode of SHARE_MODES) {
  // The transcript talks about the ordinary start and end of each value, never the secret part.
  const text = ["please check", ...PARTS.map(([, a, , z]) => `${a} ... ${z}`), "connect with the ones above"].join("\n");
  const raw = JSON.stringify({ type: "user", uuid: "u1", parentUuid: null, sessionId: "s", cwd: "/home/tester/p", version: "2.1.0", timestamp: "2026-01-01T00:00:00Z", message: { role: "user", content: text } });
  try {
    shaped.check(decoded(share(raw, shapedKnown, mode).json), shapedKnown);
  } catch {
    // shape the adapter does not accept: not counted
  }
}

// 3. Detection: a payload holding the first or last 75% of a planted value must be flagged by the policy.
// Token-shaped values (random all through) are what the backstop is for; composite ones (URL with credentials) are listed apart.
const b64 = (n: number, seed: number) => randomish(n, seed, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/");
const TOKENS: string[] = [
  fake.github(),
  fake.anthropic(),
  fake.aws(),
  fake.age(),
  fake.envValue(),
  "sk_live_" + randomish(32, 41),
  randomish(32, 43, "0123456789abcdef"),
  randomish(64, 47, "0123456789abcdef"),
  b64(40, 53),
  "xoxb-" + randomish(12, 59, "0123456789") + "-" + randomish(24, 61),
  "Zq" + randomish(22, 67),
];
const tp = new Map<string, number>();
const tpComposite = new Map<string, number>();
const group = (values: string[], into: Map<string, number>) => {
  for (const p of POLICIES)
    for (const v of values)
      for (const text of [v.slice(0, Math.ceil(v.length * 0.75)), v.slice(-Math.ceil(v.length * 0.75))])
        if (knownSecret(v, "x", "env").value.hasFragmentIn(`note ${text} end`, p)) into.set(name(p), (into.get(name(p)) ?? 0) + 1);
};
group(TOKENS, tp);
group(SHAPES.map(([, v]) => v), tpComposite);

// 4. Real sessions on this machine, counts only.
const realIdx = process.argv.indexOf("--real");
const real = new Tally();
const shipped = { payloads: 0, fragmentBlocked: 0, fragmentSuspicious: 0, otherBlocked: 0 };
let realFailed = 0;
let realSecretsMax = 0;
if (realIdx >= 0) {
  const limit = Number(process.argv[realIdx + 1] ?? 100);
  const refs = HARNESS_NAMES.flatMap((h) => listSessions(h, defaultRoots())).sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, limit);
  for (const ref of refs) {
    try {
      const raw = readFileSync(ref.path, "utf8");
      const first = share(raw, [], "brief", { machine: undefined });
      const cwd = first.session.project?.cwd;
      const known = collectKnownSecrets({ projectDir: cwd }).secrets;
      realSecretsMax = Math.max(realSecretsMax, known.length);
      const prepared = prepareShare(raw, { mode: "full", config: DEFAULT_CONFIG, knownSecrets: known, subagentFiles: loadSubagentFiles(ref.path) });
      real.check(decoded(prepared.json), known);
      // The shipped check, which also covers the values the patterns redacted (those only ask for a confirmation).
      shipped.payloads++;
      if (prepared.report.rescan.some((i) => /^secret-(prefix|suffix):/.test(i.rule))) shipped.fragmentBlocked++;
      if (prepared.report.suspicious.some((i) => /^secret-(prefix|suffix):/.test(i.rule))) shipped.fragmentSuspicious++;
      if (prepared.report.rescan.some((i) => !/^secret-(prefix|suffix):/.test(i.rule))) shipped.otherBlocked++;
    } catch {
      realFailed++;
    }
  }
}

const rows = POLICIES.map((p) => {
  const n = name(p);
  return { policy: n, fixtures: fixtures.blocked.get(n) ?? 0, shaped: shaped.blocked.get(n) ?? 0, real: real.blocked.get(n) ?? 0, detect: `${tp.get(n) ?? 0}/${TOKENS.length * 2} tokens, ${tpComposite.get(n) ?? 0}/${SHAPES.length * 2} composite` };
});
console.log(`corpora: fixtures payloads=${fixtures.payloads} (secret checks ${fixtures.secretsChecked}); shaped payloads=${shaped.payloads}; real payloads=${real.payloads} failed=${realFailed} max known per session=${realSecretsMax} secret checks ${real.secretsChecked}`);
console.log("policy | would-block payloads: fixtures, shaped, real | planted 75% fragments detected");
for (const r of rows) console.log(`${r.policy} | ${r.fixtures} ${r.shaped} ${r.real} | ${r.detect}`);

console.log(`shipped policy on real sessions (known + pattern-matched values): payloads=${shipped.payloads} blocked by the fragment check=${shipped.fragmentBlocked} needing confirmation from it=${shipped.fragmentSuspicious} blocked by any other rule=${shipped.otherBlocked}`);
