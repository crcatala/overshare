import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.js";
import { prepareShare } from "../src/pipeline.js";
import { Redactor } from "../src/redact/index.js";
import { findSecretPatterns, looksLikeCredential } from "../src/redact/patterns.js";
import { rescanPayload } from "../src/redact/rescan.js";
import { TOKEN_FORMATS, findAwsSecretKeys } from "../src/redact/token-formats.js";
import { ccUsage, ClaudeTranscript, randomish } from "./helpers.js";

/**
 * Every token here is assembled at runtime from a literal prefix and a seeded random body, so the repository holds no
 * secret-shaped string (push protection and secret scanners would flag it). The prefixes are the providers' public
 * formats; the body alphabets and lengths follow them.
 */
const ALNUM = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const LOWER = "abcdefghijklmnopqrstuvwxyz0123456789";
const UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const HEX = "0123456789abcdef";
const URL64 = `${ALNUM}-_`;
const B64 = `${ALNUM}+/`;

let seed = 100;
const body = (n: number, alphabet = ALNUM) => randomish(n, (seed += 7), alphabet);

interface Case {
  rule: string;
  token: () => string;
  /** How the token sits in text, when not bare; the match must still be exactly the token. */
  wrap?: (token: string) => string;
  ambiguous?: boolean;
}

const cases: Case[] = [
  { rule: "gitlab-token", token: () => `glrt-${body(26, URL64)}` },
  { rule: "gitlab-token", token: () => `glpat-${body(27, URL64)}.01.${body(9, LOWER)}` },
  { rule: "gitlab-token", token: () => `gldt-${body(20, URL64)}` },
  { rule: "gitlab-runner-registration", token: () => `GR1348941${body(20, URL64)}` },
  { rule: "circleci-token", token: () => `CCIPAT_${body(22)}_${body(40, LOWER)}` },
  { rule: "buildkite-token", token: () => `bkua_${body(40, HEX)}` },
  { rule: "rubygems-token", token: () => `rubygems_${body(48, HEX)}` },
  { rule: "clojars-token", token: () => `CLOJARS_${body(60, LOWER)}` },
  { rule: "docker-swarm-token", token: () => `SWMTKN-1-${body(50, LOWER)}-${body(25, LOWER)}` },
  { rule: "netlify-token", token: () => `nfp_${body(36)}` },
  { rule: "airtable-token", token: () => `pat${body(14)}.${body(64, HEX)}` },
  { rule: "vercel-token", token: () => `vcp_${body(56)}` },
  { rule: "vercel-token", token: () => `vck_${body(56)}` },
  { rule: "supabase-token", token: () => `sbp_${body(40, HEX)}` },
  { rule: "supabase-token", token: () => `sb_secret_${body(30, URL64)}` },
  { rule: "neon-key", token: () => `napi_${body(64)}` },
  { rule: "render-key", token: () => `rnd_${body(32)}`, ambiguous: true },
  { rule: "pulumi-token", token: () => `pul-${body(40, HEX)}` },
  { rule: "databricks-token", token: () => `dapi${body(32, HEX)}` },
  { rule: "planetscale-token", token: () => `pscale_tkn_${body(43, URL64)}` },
  { rule: "shopify-token", token: () => `shpat_${body(32, HEX)}` },
  { rule: "sentry-token", token: () => `sntryu_${body(64, HEX)}` },
  { rule: "tailscale-key", token: () => `tskey-api-k${body(10)}CNTRL-${body(32)}` },
  { rule: "vault-token", token: () => `hvs.${body(90, URL64)}` },
  { rule: "terraform-cloud-token", token: () => `${body(14)}.atlasv1.${body(70, URL64)}` },
  { rule: "grafana-token", token: () => `glc_${body(60, B64)}` },
  { rule: "grafana-token", token: () => `glsa_${body(32)}_${body(8, HEX)}` },
  { rule: "dynatrace-token", token: () => `dt0c01.${body(24, UPPER)}.${body(64, UPPER)}` },
  { rule: "heroku-token", token: () => `HRKU-${body(40, URL64)}` },
  { rule: "doppler-token", token: () => `dp.st.prod.${body(44)}` },
  { rule: "atlassian-token", token: () => `ATATT3${body(180, `${URL64}=`)}` },
  { rule: "aws-bedrock-key", token: () => `ABSK${body(120, B64)}` },
  { rule: "aws-bedrock-key", token: () => `bedrock-api-key-${body(60, B64)}` },
  {
    rule: "azure-storage-key",
    token: () => `${body(86, B64)}==`,
    wrap: (t) => `DefaultEndpointsProtocol=https;AccountName=store1;AccountKey=${t};EndpointSuffix=core.windows.net`,
  },
  { rule: "polar-token", token: () => `polar_pat_${body(40)}` },
  { rule: "openrouter-key", token: () => `sk-or-v1-${body(64, HEX)}` },
  { rule: "perplexity-key", token: () => `pplx-${body(48)}` },
  { rule: "cerebras-key", token: () => `csk-${body(48, LOWER)}` },
  { rule: "together-key", token: () => `tgp_v1_${body(43, URL64)}` },
  { rule: "langsmith-key", token: () => `lsv2_pt_${body(32, HEX)}_${body(10, HEX)}` },
  { rule: "langfuse-key", token: () => `sk-lf-${body(8, HEX)}-${body(4, HEX)}-${body(4, HEX)}-${body(4, HEX)}-${body(12, HEX)}` },
  { rule: "wandb-key", token: () => `wandb_v1_${body(60, `${ALNUM}_`)}` },
  { rule: "nvidia-key", token: () => `nvapi-${body(64, URL64)}` },
  { rule: "pinecone-key", token: () => `pcsk_${body(60, `${ALNUM}_`)}` },
  { rule: "google-api-key", token: () => `AIza${body(35, URL64)}` },
  { rule: "google-oauth-secret", token: () => `GOCSPX-${body(28, URL64)}` },
  { rule: "google-oauth-token", token: () => `ya29.${body(100, URL64)}` },
  { rule: "google-refresh-token", token: () => `1//0${body(60, URL64)}` },
  { rule: "firebase-server-key", token: () => `AAAA${body(7, URL64)}:APA91b${body(140, URL64)}` },
  { rule: "notion-token", token: () => `ntn_${body(46)}` },
  { rule: "figma-token", token: () => `figd_${body(42, URL64)}` },
  { rule: "posthog-personal-key", token: () => `phx_${body(43)}` },
  { rule: "pypi-token", token: () => `pypi-AgEIcHlwaS5vcmc${body(150, URL64)}` },
  { rule: "slack-app-token", token: () => `xapp-1-A${body(9, UPPER)}-${body(13, "0123456789")}-${body(64, HEX)}` },
  { rule: "slack-config-token", token: () => `xoxe-1-${body(150)}` },
  { rule: "slack-session-token", token: () => `xoxd-${body(60, `${ALNUM}%+`)}` },
  { rule: "resend-key", token: () => `re_${body(8)}_${body(24)}`, ambiguous: true },
  { rule: "twilio-key", token: () => `SK${body(32, HEX)}`, ambiguous: true },
  { rule: "discord-bot-token", token: () => `M${body(24, URL64)}.${body(6, URL64)}.${body(30, URL64)}`, ambiguous: true },
  { rule: "telegram-bot-token", token: () => `${body(9, "0123456789")}:AA${body(33, URL64)}`, ambiguous: true },
];

const matchesOf = (text: string, token: string) => findSecretPatterns(text).filter((m) => text.slice(m.start, m.end) === token);

describe("provider token formats", () => {
  it("has a test case for every rule in the table", () => {
    const tested = new Set(cases.map((c) => c.rule));
    for (const f of TOKEN_FORMATS) expect(tested, f.rule).toContain(f.rule);
  });

  it.each(cases.map((c) => [`${c.rule} (${c.token().slice(0, 6)}…)`, c] as const))("finds %s bare and after `=`", (_name, c) => {
    const token = c.token();
    const wrap = c.wrap ?? ((t: string) => t);
    for (const text of [`Output was: ${wrap(token)} end`, `SOME_VALUE=${wrap(token)}`]) {
      const found = matchesOf(text, token);
      expect(found.length, text.slice(0, 40)).toBeGreaterThan(0);
      if (!c.ambiguous) expect(found.some((m) => m.confidence === "high")).toBe(true);
    }
  });

  it.each(cases.map((c) => [c.rule + (c.ambiguous ? " (ambiguous)" : ""), c] as const))("redacts %s and the re-scan agrees", (_name, c) => {
    const token = c.token();
    const r = new Redactor();
    const out = r.redactText(`tool output: ${(c.wrap ?? ((t: string) => t))(token)}\n`, "test");
    expect(out).not.toContain(token);
    expect(out).toContain("[REDACTED:");
    expect(r.counts["secret-pattern"]).toBeGreaterThan(0);
    const unredacted = rescanPayload(JSON.stringify({ text: (c.wrap ?? ((t: string) => t))(token) }));
    // High confidence blocks publishing; an ambiguous prefix only asks for confirmation.
    if (c.ambiguous) expect(unredacted.suspicious.length).toBeGreaterThan(0);
    else expect(unredacted.issues.length).toBeGreaterThan(0);
    expect(rescanPayload(JSON.stringify({ text: out }))).toEqual({ issues: [], suspicious: [] });
  });

  it("redacts a token that is preceded by punctuation or quoted", () => {
    for (const quote of ['"', "'", "`", "(", "[", "=", ":", " "]) {
      const token = `glrt-${body(26, URL64)}`;
      expect(matchesOf(`${quote}${token}${quote === "(" ? ")" : quote === "[" ? "]" : quote}`, token).length, quote).toBeGreaterThan(0);
    }
  });

  it.each([
    ["N-API function names", "napi_create_function_with_callback_info napi_get_value_string_utf8 napi_define_class"],
    ["snake_case identifiers with a prefix", "rnd_state_vector_initialiser_for_tests re_compile_pattern_for_matching vcp_get_environment_variables_list_all"],
    ["lowercase words after a prefix", "sbp_this_is_not_a_token_at_all_ok_yes_no_maybe_so cerebras csk-this-looks-like-words-only"],
    ["placeholder run", `glpat-${"x".repeat(20)} and vcp_${"X".repeat(40)}`],
    ["sequential doc example", `sk-or-v1-${"0123456789abcdef".repeat(4)}`],
    ["too short", `AIza${body(20, URL64)} ghost_${body(8)}`],
    ["a prefix word in prose", "The pat is on the dapi side, and the pplx-ish naming of hvs is odd; see vc_ docs, xapp- tokens, ya29. style"],
    ["telegram-like with a short body", `12345678:AA${body(10, URL64)}`],
    ["a prefix glued to letters", `aaaaglrt-${body(26, URL64)} xvcp_${body(40)}`],
  ])("leaves %s alone", (_name, text) => {
    const r = new Redactor();
    expect(r.redactText(text)).toBe(text);
    expect(r.findings).toEqual([]);
  });

  it("does not match inside a longer identifier for ambiguous prefixes", () => {
    const r = new Redactor();
    const text = `my_re_${body(8)}_${body(24)} and the_rnd_${body(32)}`;
    expect(r.redactText(text)).toBe(text);
  });

  it("keeps surrounding text and redacts only the token", () => {
    const token = `sk-or-v1-${body(64, HEX)}`;
    const r = new Redactor();
    expect(r.redactText(`before ${token} after`)).toBe("before [REDACTED:openrouter-key] after");
  });
});

describe("AWS secret key beside its key id", () => {
  const keyId = () => `AKIA${body(16, "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567")}`;
  const secret = () => body(40, B64);
  const sha = () => body(40, HEX);

  it("finds an unlabelled secret within a few lines of the id", () => {
    const s = secret();
    const text = `[prod]\nid  ${keyId()}\nkey_material  ${s}\n`;
    const found = findAwsSecretKeys(text);
    expect(found.map((m) => text.slice(m.start, m.end))).toEqual([s]);
    expect(found[0]?.rule).toBe("aws-secret-key");
  });

  it("finds it on the line before the id, and when both share a line", () => {
    const s = secret();
    for (const text of [`${s}\n${keyId()}\n`, `${keyId()} ${s}`, `${keyId()}:${s}`]) {
      expect(findAwsSecretKeys(text).map((m) => text.slice(m.start, m.end)), text.length.toString()).toEqual([s]);
    }
  });

  it("redacts it through the Redactor, whatever the variable is called", () => {
    const s = secret();
    const r = new Redactor();
    const out = r.redactText(`export A=${keyId()}\nexport ZED=${s}\n`);
    expect(out).not.toContain(s);
    expect(out).toContain("[REDACTED:aws-secret-key]");
  });

  it("ignores a 40-character hex string (a git sha) beside the id", () => {
    expect(findAwsSecretKeys(`${keyId()}\ncommit ${sha()}\n`)).toEqual([]);
  });

  it("ignores a candidate far from any key id, and a lone secret-shaped string with no id", () => {
    const text = `${keyId()}\n${"filler line\n".repeat(12)}${secret()}\n`;
    expect(findAwsSecretKeys(text)).toEqual([]);
    expect(findAwsSecretKeys(`just a value ${secret()}`)).toEqual([]);
  });

  it("ignores low-variety 40-character text", () => {
    expect(findAwsSecretKeys(`${keyId()}\nthis_is_a_long_descriptive_name_not_a_key\n`)).toEqual([]);
    expect(findAwsSecretKeys(`${keyId()}\n${"ab".repeat(20)}\n`)).toEqual([]);
  });

  it("leaves the documented AWS example pair alone", () => {
    const r = new Redactor();
    const text = "AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE\nAWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY\n";
    expect(r.redactText(text)).toBe(text);
  });
});

describe("strong-context credentials", () => {
  const password = () => `Pg${body(18)}9`; // 21 characters, as a person would pick: too regular for `looksLikeSecret`
  // 16 random characters: the generic path leaks every one of these in a header (its entropy bar is near the maximum).
  const credential = () => body(16);

  it.each([
    ["Authorization Bearer", (v: string) => `curl -H "Authorization: Bearer ${v}" https://api.internal.example-corp.io/v1/things`],
    ["X-Api-Key", (v: string) => `curl -H 'X-Api-Key: ${v}' https://svc.internal.example-corp.io`],
    ["Private-Token", (v: string) => `curl --header "Private-Token: ${v}" https://git.internal.example-corp.io/api/v4/projects`],
    ["X-Amz-Security-Token", (v: string) => `-H "X-Amz-Security-Token: ${v}"`],
    ["Authorization Basic", (v: string) => `Authorization: Basic ${v}`],
    ["JSON headers object", (v: string) => JSON.stringify({ headers: { Authorization: `Bearer ${v}` } })],
  ])("redacts a header credential: %s", (_name, make) => {
    const value = credential();
    const r = new Redactor();
    const out = r.redactText(make(value));
    expect(out).not.toContain(value);
    expect(out).toContain("[REDACTED:");
  });

  it("redacts every one of many random header credentials, which the generic path misses at these lengths", () => {
    for (const len of [12, 16, 21]) {
      let leaked = 0;
      for (let i = 0; i < 100; i++) {
        const v = body(len);
        if (new Redactor().redactText(`curl -H "Authorization: Bearer ${v}" https://api.internal.example-corp.io/v1`).includes(v)) leaked++;
      }
      // A random draw with no digit is not accepted below 16 characters (an identifier is as likely): about one in eight at
      // 12, none to speak of above. Never most of them, which is what the generic path leaks (all at 12 and 16).
      expect(leaked, `length ${len}`).toBeLessThanOrEqual(len === 12 ? 25 : 3);
    }
  });

  it.each([
    ["curl -u", (v: string) => `curl -u admin:${v} https://internal.example-corp.io/api`],
    ["curl --user", (v: string) => `curl --user svc-account:${v} -X POST https://internal.example-corp.io/api`],
    ["curl -u with =", (v: string) => `curl --user=svc:${v} https://internal.example-corp.io`],
    ["quoted", (v: string) => `curl -s -u "ci-bot:${v}" https://internal.example-corp.io`],
  ])("redacts a curl password: %s", (_name, make) => {
    const value = password();
    const r = new Redactor();
    const out = r.redactText(make(value));
    expect(out).not.toContain(value);
    expect(out).toContain("[REDACTED:");
    expect(out).toContain("curl");
  });

  it.each([
    ["env var reference", "curl -H 'Authorization: Bearer ${API_TOKEN}' https://example.com"],
    ["shell variable", 'curl -H "Authorization: Bearer $TOKEN" https://example.com'],
    ["angle placeholder", "Authorization: Bearer <your-token-here>"],
    ["template placeholder", 'curl -H "X-Api-Key: {{ api_key }}"'],
    ["words only", "Authorization: Bearer this-is-just-some-words"],
    ["env password in curl -u", "curl -u $USER:$PASS https://example.com"],
    ["documented password", "curl -u username:password https://example.com"],
    ["curl -u without a password (prompts)", "curl -u admin https://example.com"],
    ["header without a value", 'curl -H "Authorization:" -H "X-Trace-Id: abc" https://example.com'],
    ["trace-id style header", "X-Request-Id: 8f14e45f-ceea-467a-9575-2a3b6c1d9e10"],
    ["camelCase identifier as a header value", "headers = { 'X-CSRF-Token': csrfTokenValue, 'X-Api-Key': getApiKeyFromStore }"],
    ["identifier assigned to apiKey", "let apiKey=vertexClientKeyName; const api_key = someLongIdentifierName;"],
    ["Capitalised words after Bearer", "Authorization: Bearer Sentence-Case-Words"],
    ["curl -u password in prose with trailing punctuation", "use `curl -u user:password` or `--user user:password`, then retry"],
  ])("leaves %s alone", (_name, text) => {
    const r = new Redactor();
    expect(r.redactText(text)).toBe(text);
  });

  it("looksLikeCredential is lower than looksLikeSecret for a plausible password and still rejects words", () => {
    expect(looksLikeCredential(password())).toBe(true);
    expect(looksLikeCredential(credential())).toBe(true);
    expect(looksLikeCredential("this-is-just-some-words")).toBe(false);
    expect(looksLikeCredential("short1")).toBe(false);
    expect(looksLikeCredential("${API_TOKEN}")).toBe(false);
    expect(looksLikeCredential("x".repeat(30))).toBe(false);
  });
});

describe("password keys spelled pw and psw", () => {
  const value = () => `Zq${body(14)}!8`;

  it.each([
    ["MONGO_URL_PW=%s"],
    ["db_pw: %s"],
    ["export REDIS_PW=%s"],
    ["psw = '%s'"],
    ["app.psw=%s"],
    ['{"admin_pw": "%s"}'],
  ])("redacts an assignment: %s", (template) => {
    const v = value();
    const r = new Redactor();
    const out = r.redactText(template.replace("%s", v));
    expect(out).not.toContain(v);
  });

  it("redacts a value under a pw key as a field", () => {
    const v = value();
    const r = new Redactor();
    for (const key of ["pw", "db_pw", "user.pw", "psw", "admin-psw"]) {
      expect(r.redactField(key, v, "t"), key).not.toContain(v);
    }
  });

  it.each([
    ["boolean flag", "show_pw = true"],
    ["a word containing pw", "const pwa = loadManifest('manifest.json') // pwa support"],
    ["a different key", "pwned_count: 12345678"],
    ["a placeholder", "db_pw = ${DB_PW}"],
    ["not a key", "the _pw suffix is used for password fields in this schema"],
  ])("leaves %s alone", (_name, text) => {
    const r = new Redactor();
    expect(r.redactText(text)).toBe(text);
  });
});

describe("through the real pipeline", () => {
  const machine = { homeDir: "/home/tester", username: "tester", hostname: "box" };

  /** A deploy log as a tool result: tokens printed bare, as a script or an SDK would, with no variable name in front. */
  function deployLog() {
    const tokens = {
      vercel: `vcp_${body(56)}`,
      openrouter: `sk-or-v1-${body(64, HEX)}`,
      google: `AIza${body(35, URL64)}`,
      gitlab: `glrt-${body(26, URL64)}`,
      slack: `xapp-1-A${body(9, UPPER)}-${body(13, "0123456789")}-${body(64, HEX)}`,
      bearer: body(16),
      curlPassword: `Pg${body(18)}9`,
      awsId: `AKIA${body(16, "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567")}`,
      awsSecret: body(40, B64),
    };
    const log = [
      "[deploy] 12:01:44 vercel auth ok: " + tokens.vercel,
      "[deploy] 12:01:45 llm fallback via " + tokens.openrouter,
      "[deploy] 12:01:45 geocoder https://maps.example-corp.io/v2?key=" + tokens.google,
      "[deploy] 12:01:46 runner registered " + tokens.gitlab,
      "[deploy] 12:01:47 slack socket mode " + tokens.slack,
      `+ curl -s -H "Authorization: Bearer ${tokens.bearer}" https://billing.internal.example-corp.io/health`,
      `+ curl -s -u deploy-bot:${tokens.curlPassword} https://registry.internal.example-corp.io/v2/`,
      "[prod]",
      "id  " + tokens.awsId,
      "key_material  " + tokens.awsSecret,
      "[deploy] 12:01:52 done in 8.1s",
    ].join("\n");
    const raw = new ClaudeTranscript("sess-token-formats", "/home/tester/work/app")
      .user("The deploy script is failing, can you check the log?")
      .assistant("m1", [{ type: "tool_use", id: "b1", name: "Bash", input: { command: "tail -n 12 logs/deploy.log" } }], ccUsage(10, 5))
      .toolResult("b1", log)
      .assistant("m2", [{ type: "text", text: "The log shows the deploy finished; nothing is failing." }], ccUsage(10, 5))
      .toJsonl();
    return { raw, tokens };
  }

  it("full mode leaves none of the bare tokens in the payload and names the rules in the report", () => {
    const { raw, tokens } = deployLog();
    const { json, report } = prepareShare(raw, { mode: "full", config: DEFAULT_CONFIG, harness: "claude-code", machine, knownSecrets: [] });
    for (const [name, value] of Object.entries(tokens)) expect(json, name).not.toContain(value);
    expect(report.blocked).toBe(false);
    expect(report.clean).toBe(false);
    const rules = new Set(report.findings.filter((f) => f.category === "secret-pattern").map((f) => f.rule.replace(/ \((high|medium)\)$/, "")));
    for (const rule of ["vercel-token", "openrouter-key", "google-api-key", "gitlab-token", "slack-app-token", "auth-header", "curl-user-password", "aws-secret-key"]) {
      expect(rules, rule).toContain(rule);
    }
    // The log's structure survives around the redactions.
    expect(json).toContain("[deploy] 12:01:52 done in 8.1s");
    expect(json).toContain("curl -s -u deploy-bot:[REDACTED:curl-user-password]");
  });

  it("brief mode never carries the tool output, so it is clean", () => {
    const { raw } = deployLog();
    expect(prepareShare(raw, { mode: "brief", config: DEFAULT_CONFIG, harness: "claude-code", machine, knownSecrets: [] }).report.clean).toBe(true);
  });
});
