/**
 * Test fixtures are built in code. Fake credentials are assembled from pieces so the
 * repository never contains literal secret-shaped strings (which would trip secret
 * scanners / push protection).
 */

const ALNUM = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

/** Deterministic pseudo-random string (mulberry32; no sequential runs, so it isn't "obviously fake"). */
export function randomish(length: number, seed = 7, alphabet = ALNUM): string {
  let a = seed >>> 0;
  let out = "";
  for (let i = 0; i < length; i++) {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    const r = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    out += alphabet[Math.floor(r * alphabet.length)];
  }
  return out;
}

export const fake = {
  github: () => ["gh", "p_", randomish(36, 11)].join(""),
  anthropic: () => ["sk", "-ant-", "api03-", randomish(93, 13, ALNUM + "-_"), "AA"].join(""),
  aws: () => ["AK", "IA", randomish(16, 17, "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567")].join(""),
  pem: () => ["-----BEGIN ", "RSA PRIVATE KEY-----\nMIIEow", randomish(64, 19), "\n-----END RSA PRIVATE KEY-----"].join(""),
  postgres: () => ["postgres://admin:", "Pw", randomish(14, 23), "@db.internal:5432/app"].join(""),
  age: () => ["AGE-SECRET-KEY-", "1", randomish(58, 29, "QPZRY9X8GF2TVDW0S3JN54KHCE6MUA7L")].join(""),
  envValue: () => `v${randomish(31, 31)}`,
};

type Json = Record<string, unknown>;

/** Claude Code transcript builder: produces chained JSONL lines. */
export class ClaudeTranscript {
  lines: Json[] = [];
  private seq = 0;
  private last: string | null = null;
  constructor(
    readonly sessionId = "11111111-2222-3333-4444-555555555555",
    readonly cwd = "/home/tester/work/demo",
  ) {}

  private base(type: string, extra: Json = {}, parent: string | null = this.last): Json {
    this.seq += 1;
    const uuid = `u-${this.seq}`;
    const entry = {
      type,
      uuid,
      parentUuid: parent,
      sessionId: this.sessionId,
      cwd: this.cwd,
      version: "2.1.0",
      gitBranch: "main",
      timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, this.seq)).toISOString(),
      ...extra,
    };
    this.lines.push(entry);
    this.last = uuid;
    return entry;
  }

  get lastUuid(): string | null {
    return this.last;
  }

  /** Continue from an earlier entry (simulates a rewind fork). */
  rewindTo(uuid: string | null): this {
    this.last = uuid;
    return this;
  }

  user(content: unknown, extra: Json = {}): this {
    this.base("user", { message: { role: "user", content }, ...extra });
    return this;
  }

  attachment(attachment: Json): this {
    this.base("attachment", { attachment });
    return this;
  }

  system(subtype: string, extra: Json = {}): this {
    this.base("system", { subtype, ...extra });
    return this;
  }

  /** One API response split into one line per block, each repeating the usage. */
  assistant(id: string, blocks: Json[], usage: Json, model = "claude-test-1"): this {
    for (const block of blocks) {
      this.base("assistant", { message: { id, model, role: "assistant", content: [block], usage } });
    }
    return this;
  }

  toolResult(toolUseId: string, content: unknown, extra: Json = {}, isError = false): this {
    this.base("user", {
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content, ...(isError ? { is_error: true } : {}) }] },
      ...extra,
    });
    return this;
  }

  meta(type: string, extra: Json): this {
    this.lines.push({ type, sessionId: this.sessionId, ...extra });
    return this;
  }

  toJsonl(): string {
    return `${this.lines.map((l) => JSON.stringify(l)).join("\n")}\n`;
  }
}

export function ccUsage(input: number, output: number, cacheRead = 0, cacheWrite = 0, thinking = 0): Json {
  return {
    input_tokens: input,
    output_tokens: output,
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheWrite,
    ...(thinking ? { output_tokens_details: { thinking_tokens: thinking } } : {}),
  };
}

/** pi transcript builder: a tree of entries with id/parentId. */
export class PiTranscript {
  lines: Json[] = [];
  private seq = 0;
  private last: string | null = null;
  constructor(
    readonly id = "01a0aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee",
    readonly cwd = "/home/tester/work/demo",
  ) {
    this.lines.push({ type: "session", version: 3, id, timestamp: "2026-01-01T00:00:00.000Z", cwd });
  }

  get lastId(): string | null {
    return this.last;
  }

  branchFrom(id: string | null): this {
    this.last = id;
    return this;
  }

  entry(type: string, extra: Json): string {
    this.seq += 1;
    const id = `e${this.seq}`;
    this.lines.push({ type, id, parentId: this.last, timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, this.seq)).toISOString(), ...extra });
    this.last = id;
    return id;
  }

  user(text: string): this {
    this.entry("message", { message: { role: "user", content: [{ type: "text", text }] } });
    return this;
  }

  assistant(content: Json[], usage: Json = piUsage(100, 10), extra: Json = {}): this {
    this.entry("message", {
      message: { role: "assistant", content, provider: "test", model: "test-model", usage, stopReason: "toolUse", ...extra },
    });
    return this;
  }

  toolResult(toolCallId: string, toolName: string, text: string, details?: unknown, isError = false): this {
    this.entry("message", {
      message: { role: "toolResult", toolCallId, toolName, content: [{ type: "text", text }], isError, ...(details ? { details } : {}) },
    });
    return this;
  }

  toJsonl(): string {
    return `${this.lines.map((l) => JSON.stringify(l)).join("\n")}\n`;
  }
}

export function piUsage(input: number, output: number, cacheRead = 0, cacheWrite = 0, cost?: number, reasoning = 0): Json {
  return { input, output, cacheRead, cacheWrite, reasoning, totalTokens: input + output + cacheRead + cacheWrite, ...(cost !== undefined ? { cost: { total: cost } } : {}) };
}
