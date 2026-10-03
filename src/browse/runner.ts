/**
 * Where `job.ts` runs. `workerRunner` starts one worker thread per request, so cancelling a request really stops
 * its CPU work (`terminate`) and a crash or an out-of-memory in one request is just a failed request. `inlineRunner`
 * runs the same code on the calling thread (tests, and nothing else).
 *
 * Workers are `unref`ed (they never keep the process alive), their output is swallowed (a stray write would corrupt
 * the full-screen UI), and a crash is reported as a fixed message: the worker's own error text is never used.
 */
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { runJob, type JobReply, type JobRequest, type JobResult, type SafeError } from "./job.js";
import { PromptsUnavailableError } from "../modes.js";

export interface JobRunner {
  /** Resolves with the result, rejects with a `JobError` (or an `AbortError` once `signal` aborts). */
  run(req: JobRequest, signal: AbortSignal): Promise<JobResult>;
  /** Stop every request in flight. */
  close(): void;
}

/** A failed job, carrying only what `SafeError` allows. A prompts refusal keeps its own class. */
export class JobError extends Error {
  constructor(readonly error: SafeError) {
    super(error.message);
    this.name = "JobError";
  }
}

export const isAbort = (err: unknown): boolean => err instanceof Error && err.name === "AbortError";
export const abortError = (): Error => Object.assign(new Error("cancelled"), { name: "AbortError" });

/** The error a caller of `Source` sees for a failed job. */
export function failure(error: SafeError): Error {
  return error.code === "prompts-unavailable" ? new PromptsUnavailableError(error.message) : new JobError(error);
}

const settle = (reply: JobReply): JobResult => {
  if (reply.ok) return reply.result;
  throw failure(reply.error);
};

export const inlineRunner: JobRunner = {
  async run(req, signal) {
    if (signal.aborted) throw abortError();
    await Promise.resolve(); // never settle synchronously, like a worker
    const reply = runJob(req);
    if (signal.aborted) throw abortError();
    return settle(reply);
  },
  close() {},
};

/** The worker's entry file: the compiled one next to this module, or the TypeScript source under tsx/vitest. */
function workerEntry(): { url: URL; execArgv: string[] } {
  if (!import.meta.url.endsWith(".ts")) return { url: new URL("./worker.js", import.meta.url), execArgv: process.execArgv };
  // Running from source: a worker does not inherit vitest's transform, and `tsx src/cli.ts` hooks only its own thread unless
  // process.execArgv carries them, so load tsx explicitly unless it is already there.
  const hasTsx = process.execArgv.some((a) => a.includes("tsx"));
  const tsx = hasTsx ? [] : ["--import", pathToFileURL(createRequire(import.meta.url).resolve("tsx/esm")).href];
  return { url: new URL("./worker.ts", import.meta.url), execArgv: [...process.execArgv, ...tsx] };
}

export function workerRunner(opts: { entry?: URL } = {}): JobRunner {
  const live = new Set<Worker>();
  const { url, execArgv } = opts.entry ? { url: opts.entry, execArgv: process.execArgv } : workerEntry();
  return {
    run(req, signal) {
      return new Promise<JobResult>((resolve, reject) => {
        if (signal.aborted) return reject(abortError());
        // The worker sees the environment of this process as it is now (known secrets are collected from it there).
        const worker = new Worker(url, { workerData: req, execArgv, env: process.env, stdout: true, stderr: true });
        worker.unref();
        worker.stdout.resume();
        worker.stderr.resume();
        live.add(worker);
        let done = false;
        const finish = (settleWith: () => void) => {
          if (done) return;
          done = true;
          signal.removeEventListener("abort", onAbort);
          live.delete(worker);
          void worker.terminate();
          settleWith();
        };
        const onAbort = () => finish(() => reject(abortError()));
        signal.addEventListener("abort", onAbort, { once: true });
        // An uncaught error, a worker that exits without answering (out of memory, killed) or one that answers with
        // something that is not a reply: fixed text only.
        const crashed = () => finish(() => reject(new JobError({ code: "internal", message: "the background reader stopped unexpectedly" })));
        worker.once("message", (reply: JobReply) => {
          if (reply?.ok === true && reply.result) finish(() => resolve(reply.result));
          else if (reply?.ok === false && reply.error) finish(() => reject(failure(reply.error)));
          else crashed();
        });
        worker.once("error", crashed);
        worker.once("exit", crashed);
      });
    },
    close() {
      for (const worker of live) void worker.terminate();
      live.clear();
    },
  };
}
