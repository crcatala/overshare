/**
 * Worker-thread entry: run one job (see `job.ts`) and post the reply, moving the payload bytes instead of copying them.
 * A worker handles exactly one request and then ends, so cancelling it (`terminate`) loses nothing but that request.
 * Only a `SafeError` is ever posted for a failure, never the original error.
 */
import { parentPort, workerData } from "node:worker_threads";
import { runJob, type JobRequest } from "./job.js";

const reply = runJob(workerData as JobRequest);
const transfer = reply.ok && reply.result.kind === "review" ? [reply.result.payload.buffer as ArrayBuffer] : [];
parentPort!.postMessage(reply, transfer);
