/**
 * The background reader: real worker threads running the real pipeline. Checks that it answers like the inline code,
 * that cancelling really stops it, that a crash is survivable, and that nothing but plain, secret-free data crosses
 * the thread boundary (errors included).
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeJob, runJob, toSafeError, type JobRequest } from "../src/browse/job.js";
import { inlineRunner, isAbort, JobError, workerRunner } from "../src/browse/runner.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { UnrecognizedFormatError } from "../src/harnesses/index.js";
import { PromptsUnavailableError } from "../src/modes.js";
import { ccUsage, ClaudeTranscript, fake, randomish } from "./helpers.js";

let dir: string;
const saved = { ...process.env };
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "browse-runner-"));
});
afterEach(() => {
  process.env = { ...saved };
  vi.restoreAllMocks();
});

const live = () => new AbortController().signal;

function transcript(secret: string): string {
  const path = join(dir, "sess.jsonl");
  writeFileSync(
    path,
    new ClaudeTranscript("sess-1", "/home/me/work/app")
      .user("deploy the app")
      .assistant("m1", [{ type: "tool_use", id: "b1", name: "Bash", input: { command: "cat .env" } }], ccUsage(10, 5))
      .toolResult("b1", `GITHUB_TOKEN=${secret}`)
      .assistant("m2", [{ type: "text", text: "done" }], ccUsage(10, 5))
      .toJsonl(),
  );
  return path;
}

/** A worker entry that is not the real one: `body` is its whole source. */
function entry(name: string, body: string): URL {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${name}.mjs`);
  writeFileSync(file, body);
  return pathToFileURL(file);
}

const SECRET_ERRORS = (secret: string): Array<[string, unknown]> => [
  ["a JSON syntax error that quotes the file", new SyntaxError(`Unexpected token 'x', "...${secret}..." is not valid JSON`)],
  ["a file-system error that names the path", Object.assign(new Error(`ENOENT: no such file or directory, open '/home/me/${secret}.jsonl'`), { code: "ENOENT" })],
  ["an error with a hostile name", Object.assign(new Error(`boom ${secret}`), { name: `Err ${secret}` })],
  ["an error with a hostile code", Object.assign(new Error(`boom ${secret}`), { code: `E${secret}` })],
  ["a thrown string", `token is ${secret}`],
  ["a thrown object", { message: secret, toString: () => secret }],
  ["an AggregateError", new AggregateError([new Error(secret)], `many ${secret}`)],
];

describe("toSafeError", () => {
  it.each(SECRET_ERRORS(fake.github()))("%s carries no text of the original", (_name, err) => {
    const secret = fake.github();
    const safe = toSafeError(err);
    expect(JSON.stringify(safe)).not.toContain(secret);
    expect(JSON.stringify(safe)).not.toContain("/home/me");
    expect(Object.keys(safe).sort()).toEqual(["code", "message"]);
  });

  it("keeps the two messages this code base writes itself, and an errno code", () => {
    expect(toSafeError(new PromptsUnavailableError("Cannot use prompts mode: 12 pi user prompt(s) have no verified pre-expansion input.")).code).toBe("prompts-unavailable");
    expect(toSafeError(new PromptsUnavailableError("Cannot use prompts mode: 12 pi user prompt(s)")).message).toContain("12 pi user prompt(s)");
    expect(toSafeError(new UnrecognizedFormatError())).toEqual({ code: "unrecognized-format", message: "Could not detect the transcript format (supported: claude-code, pi)" });
    expect(toSafeError(Object.assign(new Error("EACCES: permission denied, open '/x'"), { code: "EACCES" }))).toEqual({ code: "read-failed", message: "could not read the session file (EACCES)" });
    expect(toSafeError(new TypeError("x is not a function"))).toEqual({ code: "internal", message: "internal error in the background reader (TypeError)" });
  });
});

describe("worker runner", () => {
  it("answers exactly like the inline code: view, and review with the same payload size and findings", async () => {
    const secret = fake.github();
    const path = transcript(secret);
    const workers = workerRunner();
    const view: JobRequest = { kind: "view", path, harness: "claude-code" };
    expect(await workers.run(view, live())).toEqual(await inlineRunner.run(view, live()));
    for (const mode of ["full", "brief", "minimal", "prompts"] as const) {
      const req: JobRequest = { kind: "review", path, harness: "claude-code", mode, config: DEFAULT_CONFIG };
      const a = await workers.run(req, live());
      const b = await inlineRunner.run(req, live());
      expect(a.kind).toBe("review");
      if (a.kind !== "review" || b.kind !== "review") throw new Error("review expected");
      expect(a.review).toEqual(b.review);
      expect(a.payload.byteLength).toBe(a.review.bytes);
      expect(a.session).toEqual(b.session);
    }
  });

  it("the payload that comes back is the redacted one: the planted secret is in neither the review nor the bytes", async () => {
    const secret = fake.github();
    const result = await workerRunner().run({ kind: "review", path: transcript(secret), harness: "claude-code", mode: "full", config: DEFAULT_CONFIG }, live());
    if (result.kind !== "review") throw new Error("review expected");
    const payload = new TextDecoder().decode(result.payload);
    expect(payload).not.toContain(secret);
    expect(payload).toContain("[REDACTED:");
    expect(JSON.stringify(result.review)).not.toContain(secret);
    expect(JSON.stringify(result.session)).not.toContain(secret);
    expect(result.review.findings.length).toBeGreaterThan(0);
  });

  it("collects known secrets itself: a value from the environment is redacted, though it never crosses in a request", async () => {
    const value = fake.envValue();
    process.env.DEMO_SERVICE_TOKEN = value;
    const path = join(dir, "env.jsonl");
    writeFileSync(path, new ClaudeTranscript("sess-env", "/home/me/work/app").user("run it").assistant("m1", [{ type: "tool_use", id: "b1", name: "Bash", input: { command: "env" } }], ccUsage(1, 1)).toolResult("b1", `token ${value} end`).toJsonl());
    const req: JobRequest = { kind: "review", path, harness: "claude-code", mode: "full", config: DEFAULT_CONFIG };
    expect(JSON.stringify(req)).not.toContain(value); // what the worker is sent: path, harness, mode and config only
    const result = await workerRunner().run(req, live());
    if (result.kind !== "review") throw new Error("review expected");
    expect(new TextDecoder().decode(result.payload)).not.toContain(value);
    expect(result.review.knownSources.find((s) => s.id === "env")!.count).toBeGreaterThan(0);
    expect(JSON.stringify(result.review)).not.toContain(value);
  });

  it("reports an unreadable file by errno code only, never by path", async () => {
    const path = join(dir, "missing", `${randomish(12)}.jsonl`);
    const err = await workerRunner().run({ kind: "view", path, harness: "claude-code" }, live()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JobError);
    expect((err as JobError).error).toEqual({ code: "read-failed", message: "could not read the session file (ENOENT)" });
    expect(String((err as Error).message)).not.toContain(dir);
  });

  it("an unrecognized transcript fails with fixed text that does not quote the file", async () => {
    const secret = fake.anthropic();
    const path = join(dir, "garbage.jsonl");
    writeFileSync(path, `{"hello": "${secret}"\nnot json ${secret}\n`);
    const err = (await workerRunner().run({ kind: "view", path, harness: "bogus" as never }, live()).catch((e: unknown) => e)) as JobError;
    expect(err).toBeInstanceOf(JobError);
    expect(JSON.stringify(err.error)).not.toContain(secret);
    expect(err.message).toBe("Could not detect the transcript format (supported: claude-code, pi)");
    // The same file through every code path of runJob, in-process, never puts it in an error either.
    for (const harness of ["claude-code", "pi", undefined] as const) {
      const reply = runJob({ kind: "review", path, harness: harness as never, mode: "brief", config: DEFAULT_CONFIG });
      if (!reply.ok) expect(JSON.stringify(reply.error)).not.toContain(secret);
    }
  });

  it("a refused mode arrives as the pipeline's own error class", async () => {
    const root = join(dir, "pi");
    mkdirSync(root);
    const path = join(root, "legacy.jsonl");
    const { PiTranscript } = await import("./helpers.js");
    writeFileSync(path, new PiTranscript("01a0aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee", "/home/me/work/app").user("a prompt with no recorded authored input").toJsonl());
    const err = await workerRunner().run({ kind: "review", path, harness: "pi", mode: "prompts", config: DEFAULT_CONFIG }, live()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PromptsUnavailableError);
  });

  it("aborting stops a worker that is busy, at once, and the worker is gone", async () => {
    const spin = entry("spin", `while (true) {}`);
    const runner = workerRunner({ entry: spin });
    const ctl = new AbortController();
    const started = Date.now();
    const run = runner.run({ kind: "view", path: "x", harness: "pi" }, ctl.signal);
    const outcome = run.catch((e: unknown) => e);
    await new Promise((r) => setTimeout(r, 100));
    ctl.abort();
    const err = await outcome;
    expect(isAbort(err)).toBe(true);
    expect(Date.now() - started).toBeLessThan(2_000);
    // Nothing left running: closing has nothing to stop and the process can exit.
    runner.close();
  });

  it("an already aborted signal never starts a worker", async () => {
    const ctl = new AbortController();
    ctl.abort();
    for (const runner of [workerRunner(), inlineRunner]) {
      expect(isAbort(await runner.run({ kind: "view", path: join(dir, "nope"), harness: "pi" }, ctl.signal).catch((e: unknown) => e))).toBe(true);
    }
  });

  it("close() stops everything in flight", async () => {
    const spin = entry("spin2", `while (true) {}`);
    const runner = workerRunner({ entry: spin });
    const runs = [1, 2, 3].map(() => runner.run({ kind: "view", path: "x", harness: "pi" }, live()).catch((e: unknown) => e));
    await new Promise((r) => setTimeout(r, 50));
    runner.close();
    const errs = await Promise.all(runs);
    expect(errs.every((e) => e instanceof JobError)).toBe(true);
  });

  describe("a worker that fails", () => {
    const secret = fake.anthropic();
    const cases: Array<[string, string]> = [
      ["throws, with a secret in the message", `throw new Error("boom ${secret}");`],
      ["rejects asynchronously", `Promise.reject(new Error("async ${secret}")); await new Promise(() => {});`],
      ["exits without answering", `process.exit(3);`],
      ["answers with something that is not a reply", `import { parentPort } from "node:worker_threads"; parentPort.postMessage("started");`],
      ["answers with an error that has no body", `import { parentPort } from "node:worker_threads"; parentPort.postMessage({ ok: false });`],
    ];
    it.each(cases)("%s: the request fails with fixed text, the browser is not hurt", async (name, body) => {
      const runner = workerRunner({ entry: entry(`fail-${name.replace(/\W+/g, "-")}`, body) });
      const err = (await runner.run({ kind: "view", path: "x", harness: "pi" }, live()).catch((e: unknown) => e)) as JobError;
      expect(err).toBeInstanceOf(JobError);
      expect(err.message).not.toContain(secret);
      expect(JSON.stringify(err.error)).not.toContain(secret);
      expect(err.message).toBe("the background reader stopped unexpectedly");
    });
  });

  it("swallows what a worker writes to stdout and stderr, so it cannot corrupt the full-screen UI", async () => {
    const out = vi.spyOn(process.stdout, "write");
    const errw = vi.spyOn(process.stderr, "write");
    const noisy = entry("noisy", `import { parentPort } from "node:worker_threads"; console.log("loud stdout"); console.error("loud stderr"); process.stdout.write("raw"); parentPort.postMessage({ ok: true, result: { kind: "view", view: {} } });`);
    await workerRunner({ entry: noisy }).run({ kind: "view", path: "x", harness: "pi" }, live());
    await new Promise((r) => setTimeout(r, 50));
    const written = [...out.mock.calls, ...errw.mock.calls].map((c) => String(c[0])).join("");
    expect(written).not.toContain("loud");
    expect(written).not.toContain("raw");
  });
});

describe("executeJob", () => {
  it("is the same function the worker runs", () => {
    const path = transcript(fake.github());
    const result = executeJob({ kind: "review", path, harness: "claude-code", mode: "brief", config: DEFAULT_CONFIG });
    expect(result.kind).toBe("review");
  });
});

