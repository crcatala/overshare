import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HARNESSES, HARNESS_NAMES, UnrecognizedFormatError, detectHarness, harnesses, parseSession } from "../src/harnesses/index.js";
import { HARNESS_META, harnessLabel, metaOf } from "../src/harnesses/meta.js";
import { defaultRoots, sniffHarness } from "../src/resolve.js";
import { buildIndex } from "../src/sessions/index.js";
import { parseQuery } from "../src/sessions/query.js";
import { ClaudeTranscript, PiTranscript } from "./helpers.js";

/** One tiny transcript per harness, in its native format. */
const NATIVE: Record<(typeof HARNESS_NAMES)[number], () => string> = {
  "claude-code": () => new ClaudeTranscript("sess-1", "/work/demo").user("hi").toJsonl(),
  pi: () => new PiTranscript("01a0pi00-0000-7000-8000-000000000000").user("hi").toJsonl(),
};

describe("harness registry", () => {
  it("has a descriptor and meta for every name, under that name", () => {
    expect(HARNESS_NAMES.length).toBeGreaterThan(0);
    for (const n of HARNESS_NAMES) {
      expect(HARNESSES[n].name).toBe(n);
      expect(metaOf(n)).toBe(HARNESS_META[n]);
      expect(NATIVE[n]).toBeTypeOf("function");
    }
    expect(harnesses().map((h) => h.name)).toEqual(HARNESS_NAMES);
  });

  it("gives each harness its own sessions root and its own search words", () => {
    const roots = Object.values(defaultRoots({}));
    expect(new Set(roots).size).toBe(roots.length);
    const words = HARNESS_NAMES.flatMap((n) => [n, ...HARNESS_META[n].aliases]);
    expect(new Set(words).size).toBe(words.length);
  });

  it("takes only its own format: a harness's detect says no to every other harness's transcript", () => {
    for (const n of HARNESS_NAMES) {
      const entries = NATIVE[n]().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
      expect(entries.some((e) => HARNESSES[n].detect(e))).toBe(true);
      expect(detectHarness(NATIVE[n]())).toBe(n);
      for (const other of HARNESS_NAMES.filter((o) => o !== n)) {
        expect(entries.filter((e) => HARNESSES[other].detect(e))).toEqual([]);
      }
    }
  });

  it("parses by detection when no harness is named", () => {
    for (const n of HARNESS_NAMES) expect(parseSession(NATIVE[n]()).session.harness.name).toBe(n);
  });
});

describe("a name that is not a harness", () => {
  it("is refused with the fixed message, whatever the string", () => {
    for (const name of ["codex", "constructor", "__proto__", "toString"]) {
      const err = (() => {
        try {
          parseSession(NATIVE["claude-code"](), name as never);
        } catch (e) {
          return e;
        }
      })();
      expect(err).toBeInstanceOf(UnrecognizedFormatError);
      expect((err as Error).message).toBe(`Could not detect the transcript format (supported: ${HARNESS_NAMES.join(", ")})`);
    }
  });

  it("shows as itself in the viewer, and is not looked up as a property", () => {
    expect(harnessLabel("claude-code")).toBe("Claude Code");
    expect(harnessLabel("codex")).toBe("codex");
    expect(harnessLabel("constructor")).toBe("constructor");
    expect(metaOf("__proto__")).toBeUndefined();
    expect(metaOf(undefined)).toBeUndefined();
  });
});

describe("harness: in a search", () => {
  it("takes a harness's name or any alias, and nothing else", () => {
    expect(parseQuery("harness:cc").harness).toBe("claude-code");
    expect(parseQuery("harness:claude").harness).toBe("claude-code");
    expect(parseQuery("harness:Claude-Code").harness).toBe("claude-code");
    expect(parseQuery("harness:pi").harness).toBe("pi");
    expect(parseQuery("harness:codex").harness).toBeUndefined();
    expect(parseQuery("harness:constructor").harness).toBeUndefined();
  });
});

describe("sniffHarness", () => {
  const dir = mkdtempSync(join(tmpdir(), "as-sniff-"));
  const write = (name: string, text: string) => {
    const path = join(dir, name);
    writeFileSync(path, text);
    return path;
  };

  it("names the harness of a transcript file", () => {
    for (const n of HARNESS_NAMES) expect(sniffHarness(write(`${n}.jsonl`, NATIVE[n]()))).toBe(n);
  });

  it("looks past bookkeeping lines that carry nothing to recognise", () => {
    const text = `${JSON.stringify({ type: "file-history-snapshot", messageId: "m1", snapshot: {} })}\n${NATIVE["claude-code"]()}`;
    expect(sniffHarness(write("snapshot-first.jsonl", text))).toBe("claude-code");
  });

  it("finds a Claude Code transcript whose first line is far longer than a block (a big paste in the first message)", () => {
    const text = new ClaudeTranscript("sess-big", "/work/demo").user(`${"é".repeat(150_000)}`).user("second").toJsonl();
    expect(Buffer.byteLength(text.split("\n", 1)[0]!)).toBeGreaterThan(2 * 64 * 1024);
    expect(sniffHarness(write("big-first.jsonl", text))).toBe("claude-code");
  });

  it("finds a transcript after a long run of lines that name no harness", () => {
    const snapshot = JSON.stringify({ type: "file-history-snapshot", messageId: "m1", snapshot: {} });
    const text = `${Array(500).fill(snapshot).join("\n")}\n${NATIVE["claude-code"]()}`;
    expect(sniffHarness(write("long-prefix.jsonl", text))).toBe("claude-code");
  });

  it("refuses a file no harness claims, rather than guessing the first one", () => {
    expect(() => sniffHarness(write("other.jsonl", '{"hello":"world"}\nnot json\n'))).toThrow(UnrecognizedFormatError);
    expect(() => sniffHarness(write("empty.jsonl", ""))).toThrow(UnrecognizedFormatError);
  });
});

describe("the session index across builds", () => {
  it("reads a session again when its cache entry names another harness, instead of trusting it", () => {
    const base = mkdtempSync(join(tmpdir(), "as-stale-"));
    const claude = join(base, "claude");
    mkdirSync(join(claude, "-work-demo"), { recursive: true });
    writeFileSync(join(claude, "-work-demo", "sess-1.jsonl"), NATIVE["claude-code"]());
    const roots = { "claude-code": claude, pi: join(base, "pi") };
    const cachePath = join(base, "cache.json");
    buildIndex({ roots, cachePath });
    const file = JSON.parse(readFileSync(cachePath, "utf8")) as { sessions: Record<string, { harness: string }> };
    for (const s of Object.values(file.sessions)) s.harness = "a-harness-this-build-lacks";
    writeFileSync(cachePath, JSON.stringify(file));
    let parsed = 0;
    const [only] = buildIndex({ roots, cachePath, onProgress: (p) => (parsed = Math.max(parsed, p.parsed)) });
    expect(parsed).toBe(1);
    expect(only?.harness).toBe("claude-code");
  });
});
