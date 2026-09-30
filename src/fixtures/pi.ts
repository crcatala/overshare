import { createHash } from "node:crypto";
import { PI_INPUT_PROVENANCE_TYPE } from "../schema.js";
import { TINY_PNG } from "./claude-code.js";
import type { Rng } from "./random.js";
import type { Block, Item, SessionScript, ToolCall } from "./script.js";
import { TokenModel, costOf } from "./tokens.js";

type Json = Record<string, unknown>;

/** Emit a pi transcript (`~/.pi/agent/sessions/--<slug>--/<ts>_<id>.jsonl`) for a script. */
export function emitPi(script: SessionScript, rng: Rng, opts: { sessionId: string; start: number; home: string; inputProvenance?: boolean }): string {
  const lines: Json[] = [];
  const tokens = new TokenModel(rng, "openai", 9_000);
  let last: string | null = null;
  let now = opts.start;
  let provider = "openai-codex";
  let model = "gpt-6-luna";

  const tick = (min: number, max: number) => {
    now += rng.int(min, max) * 1000;
    return new Date(now).toISOString();
  };
  const entry = (type: string, extra: Json): string => {
    const id = rng.hex(8);
    lines.push({ type, id, parentId: last, timestamp: tick(1, 4), ...extra });
    last = id;
    return id;
  };
  const message = (msg: Json) => entry("message", { message: { timestamp: now, ...msg } });
  const userMessage = (text: string, content: Json[]) => {
    const timestamp = now;
    if (opts.inputProvenance !== false) {
      const stored = content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
      entry("custom", { customType: PI_INPUT_PROVENANCE_TYPE, data: {
        version: 1, text, source: "interactive", messageTimestamp: timestamp,
        messageHash: createHash("sha256").update(stored).digest("hex"),
      } });
    }
    message({ role: "user", content, timestamp });
  };

  lines.push({ type: "session", version: 3, id: opts.sessionId, timestamp: new Date(now).toISOString(), cwd: script.cwd });
  entry("model_change", { provider, modelId: model });
  entry("thinking_level_change", { thinkingLevel: "medium" });
  entry("session_info", { name: script.title });

  const assistant = (content: Json[], usage: ReturnType<TokenModel["respond"]>, stopReason: string, extra: Json = {}) => {
    const cost = costOf(usage, { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 });
    message({
      role: "assistant",
      content,
      api: "openai-codex-responses",
      provider,
      model,
      usage: {
        ...usage,
        totalTokens: usage.input + usage.output + usage.cacheRead + usage.cacheWrite,
        cost: { input: (usage.input * 1.25) / 1e6, output: (usage.output * 10) / 1e6, cacheRead: (usage.cacheRead * 0.125) / 1e6, cacheWrite: 0, total: cost },
      },
      stopReason,
      ...extra,
    });
  };

  const emit = (items: Item[]) => {
    for (const item of items) {
      switch (item.t) {
        case "prompt":
        case "queuedPrompt": {
          tick(20, 120);
          const content: Json[] = [{ type: "text", text: item.text }];
          if (item.t === "prompt" && item.image) content.push({ type: "image", data: TINY_PNG, mimeType: "image/png" });
          userMessage(item.text, content);
          tokens.add(item.text.length);
          break;
        }
        case "commandPrompt":
          // pi prompt templates expand client-side; the transcript holds the expanded text.
          userMessage(`${item.name}${item.args ? ` ${item.args}` : ""}`, [{ type: "text", text: item.expanded }]);
          tokens.add(item.expanded.length);
          break;
        case "response": {
          const blocks = item.blocks.filter((b) => !(b.k === "tool" && b.call.only === "claude-code"));
          if (!blocks.length) break;
          tick(3, 40);
          const calls: { id: string; block: Block; name: string }[] = [];
          const content = blocks.map((b): Json => {
            if (b.k === "thinking") return { type: "thinking", thinking: b.text, thinkingSignature: rng.token(40) };
            if (b.k === "text") return { type: "text", text: b.text };
            const id = `call_${rng.token(24)}|fc_${rng.hex(40)}`;
            const [name, args] = piTool(b, rng);
            calls.push({ id, block: b, name });
            return { type: "toolCall", id, name, arguments: args };
          });
          const reasoning = blocks.reduce((n, b) => n + (b.k === "thinking" ? b.tokens : 0), 0);
          assistant(content, tokens.respond(JSON.stringify(content).length, reasoning), calls.length ? "toolUse" : "stop");
          tick(1, 20);
          for (const { id, block, name } of calls) {
            if (block.k === "subagentList") {
              message({ role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text: "No active runs." }], isError: false, details: { mode: "management", results: [] } });
            } else if (block.k === "subagent") {
              const u = block.call.usage;
              message({
                role: "toolResult",
                toolCallId: id,
                toolName: name,
                content: [{ type: "text", text: block.call.output }],
                isError: false,
                details: {
                  mode: "workflow",
                  runId: rng.hex(12),
                  totalChildUsage: { input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: 0, cost: u.cost, turns: u.turns },
                  totalCost: { inputTokens: u.input, outputTokens: u.output, costUsd: u.cost },
                },
              });
              tokens.add(block.call.output.length);
            } else if (block.k === "tool") {
              const c = block.call;
              const resultContent: Json[] = [{ type: "text", text: c.output }];
              if (c.image) resultContent.push({ type: "image", data: TINY_PNG, mimeType: "image/png" });
              message({ role: "toolResult", toolCallId: id, toolName: name, content: resultContent, isError: !!c.isError });
              tokens.add(c.output.length);
            }
          }
          break;
        }
        case "interrupt":
          assistant([{ type: "text", text: "Wiring up the logger now —" }], tokens.respond(40, 0), "aborted");
          break;
        case "apiError":
          assistant([], { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, "error", { errorMessage: item.text });
          break;
        case "compaction":
          entry("compaction", { summary: item.summary, firstKeptEntryId: last, tokensBefore: tokens.contextTokens });
          tokens.compact();
          break;
        case "idle":
          now += item.minutes * 60_000;
          tokens.expireCache();
          break;
        case "modelChange":
          provider = "anthropic";
          model = item.model;
          tokens.expireCache(); // The cache is per model.
          entry("model_change", { provider, modelId: model });
          break;
        case "thinkingLevel":
          entry("thinking_level_change", { thinkingLevel: item.level });
          break;
        case "subagentNotice":
          entry("custom_message", { customType: "subagent-notify", content: item.text, display: false });
          break;
        case "abandoned": {
          const fork = last;
          emit(item.items);
          last = fork;
          break;
        }
        case "command":
        case "skill":
          break; // No pi transcript equivalent.
      }
    }
  };
  emit(script.items);
  return `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`;
}

function piTool(b: Block, rng: Rng): [string, Json] {
  if (b.k === "subagentList") return ["subagent", { action: "list" }];
  if (b.k === "subagent") {
    const runs = b.call.agents.map((a) => `{ key: '${a.toLowerCase()}', agent: '${a.toLowerCase()}', task: ${JSON.stringify(b.call.prompt)} }`).join(", ");
    return ["subagent", { async: "true", chatProgress: "true", workflowScript: `return runs.all([${runs}])`, mission: JSON.stringify({ title: b.call.description }) }];
  }
  if (b.k !== "tool") throw new Error("unreachable");
  const c: ToolCall = b.call;
  switch (c.kind) {
    case "read":
      return ["read", { path: c.path }];
    case "edit":
      return ["edit", { path: c.path, edits: [{ oldText: c.oldText, newText: c.newText }] }];
    case "write":
      return ["write", { path: c.path, content: c.content }];
    case "bash":
      return ["bash", { command: c.command, ...(rng.chance(0.5) ? { timeout: 120 } : {}) }];
    case "grep":
      return ["grep", { pattern: c.pattern, path: c.path }];
    case "glob":
      return ["find", { pattern: c.pattern, path: "." }];
    case "web":
      return ["bash", { command: `curl -sL ${c.url} | html2text | head -60` }];
    case "todo":
    case "mcp":
      return ["bash", { command: "true" }];
  }
}
