import { TINY_PNG } from "./claude-code.js";
import type { Rng } from "./random.js";
import type { Block, Item, SessionScript, ToolCall } from "./script.js";
import { TokenModel } from "./tokens.js";

type Json = Record<string, unknown>;

/**
 * Emit a Codex rollout (`~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl`, history mode `paginated`, as CLI
 * 0.16x writes it) for a script. Tool calls are code-mode `exec` calls fanning out to commands; edits are
 * `apply_patch`; subagents are `spawn_agent` calls (their own rollouts are not written). Rewound branches do not exist
 * in Codex and are left out.
 */
export function emitCodex(script: SessionScript, rng: Rng, opts: { sessionId: string; start: number; home: string }): string {
  const lines: Json[] = [];
  const tokens = new TokenModel(rng, "openai", 12_000);
  let now = opts.start;
  let ordinal = 0;
  let model = "gpt-6.1-sol";
  let effort = "medium";
  let turnId = "";
  let first = true;
  const total = { input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 0 };

  const tick = (min: number, max: number) => {
    now += rng.int(min, max) * 1000;
    return new Date(now).toISOString();
  };
  const line = (type: string, payload: Json, extra: Json = {}) => lines.push({ timestamp: new Date(now).toISOString(), ordinal: ordinal++, type, payload, ...extra });
  const event = (payload: Json) => line("event_msg", payload);
  const item = (it: Json) => event({ type: "item_completed", thread_id: opts.sessionId, turn_id: turnId, item: it, started_at_ms: now, completed_at_ms: now });
  const id = (prefix: string) => `${prefix}_${rng.hex(24)}`;
  const turnContext = () => line("turn_context", { turn_id: turnId, cwd: script.cwd, approval_policy: "on-request", sandbox_policy: { type: "workspace-write" }, model, collaboration_mode: { mode: "default", settings: { model, reasoning_effort: effort } }, effort });

  const usage = (outputChars: number, reasoning: number) => {
    const u = tokens.respond(outputChars, reasoning);
    const record = { input_tokens: u.input + u.cacheRead, cached_input_tokens: u.cacheRead, cache_write_input_tokens: 0, output_tokens: u.output, reasoning_output_tokens: u.reasoning, total_tokens: u.input + u.cacheRead + u.output };
    for (const k of Object.keys(total) as (keyof typeof total)[]) total[k] += record[k];
    line("token_usage_record", { thread_id: opts.sessionId, turn_id: turnId, response_id: id("resp"), usage: record, thread_token_usage: { ...total } });
    event({ type: "token_count", info: { total_token_usage: { ...total }, last_token_usage: record, model_context_window: 400_000 } });
  };

  lines.push({
    timestamp: new Date(now).toISOString(),
    ordinal: ordinal++,
    type: "session_meta",
    payload: {
      session_id: opts.sessionId,
      id: opts.sessionId,
      timestamp: new Date(now).toISOString(),
      cwd: script.cwd,
      originator: "codex_cli_rs",
      cli_version: "0.169.0",
      source: "cli",
      thread_source: "user",
      model_provider: "openai",
      base_instructions: { text: "You are Codex, a coding agent." },
      history_mode: "paginated",
      git: { branch: "fix/invoice-currency", repository_url: `https://example.invalid/acme/${script.project}.git` },
    },
  });

  const prompt = (text: string, opts2: { image?: boolean; skill?: string } = {}) => {
    tick(20, 120);
    turnId = `${rng.hex(8)}-${rng.hex(4)}-7${rng.hex(3)}-8${rng.hex(3)}-${rng.hex(12)}`;
    event({ type: "task_started", turn_id: turnId });
    line("response_item", { type: "message", role: "developer", content: [{ type: "input_text", text: "<permissions instructions>…</permissions instructions>" }], internal_chat_message_metadata_passthrough: { content_item_kinds: ["permissions.instructions"] } });
    if (first) {
      line("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: `# AGENTS.md instructions for ${script.cwd}\n\nRun tests with npm test.` }, { type: "input_text", text: `<environment_context>\n  <cwd>${script.cwd}</cwd>\n</environment_context>` }], internal_chat_message_metadata_passthrough: { content_item_kinds: ["agents_md.instructions", "environment_context"] } });
      first = false;
    }
    turnContext();
    line("response_item", { type: "message", role: "user", content: [{ type: "input_text", text }, ...(opts2.image ? [{ type: "input_image", image_url: `data:image/png;base64,${TINY_PNG}` }] : [])], internal_chat_message_metadata_passthrough: { content_item_kinds: ["user.text", ...(opts2.image ? ["user.image"] : [])] } });
    item({ type: "UserMessage", id: id("um"), content: [{ type: "text", text, text_elements: [] }, ...(opts2.image ? [{ type: "local_image", path: `${opts.home}/Desktop/screenshot.png` }] : []), ...(opts2.skill ? [{ type: "skill", name: opts2.skill, path: `${opts.home}/.codex/skills/${opts2.skill}/SKILL.md` }] : [])] });
    tokens.add(text.length);
  };

  /** One model response: reasoning, text, then its calls (consecutive commands share one code-mode `exec`). */
  const respond = (blocks: Block[]) => {
    const visible = blocks.filter((b) => !(b.k === "tool" && b.call.only === "claude-code") && b.k !== "subagentList");
    if (!visible.length) return;
    tick(3, 40);
    const reasoning = visible.reduce((n, b) => n + (b.k === "thinking" ? b.tokens : 0), 0);
    const hasCalls = visible.some((b) => b.k === "tool" || b.k === "subagent");
    let outputChars = 0;
    for (const b of visible) {
      if (b.k === "thinking") {
        line("response_item", { type: "reasoning", id: id("rs"), summary: [{ type: "summary_text", text: b.text }], encrypted_content: `gAAAAA${rng.token(160)}` });
        outputChars += b.text.length;
      } else if (b.k === "text") {
        item({ type: "AgentMessage", id: id("msg"), content: [{ type: "Text", text: b.text }], phase: hasCalls ? "commentary" : "final_answer" });
        line("response_item", { type: "message", role: "assistant", id: id("msg"), content: [{ type: "output_text", text: b.text }], phase: hasCalls ? "commentary" : "final_answer" });
        outputChars += b.text.length;
      }
    }
    const calls = visible.filter((b): b is Extract<Block, { k: "tool" | "subagent" }> => b.k === "tool" || b.k === "subagent");
    if (!calls.length) {
      usage(outputChars, reasoning);
      return;
    }
    // In the story's order: each run of adjacent commands and searches is one `exec` call; an edit or a subagent is a
    // call of its own. The response's usage is recorded after its first call, as Codex writes it.
    let recorded = false;
    const record = (chars: number) => {
      if (!recorded) usage(outputChars + chars, reasoning);
      recorded = true;
    };
    const isCommand = (b: Block): boolean => b.k === "tool" && b.call.kind !== "edit" && b.call.kind !== "write" && b.call.kind !== "todo" && b.call.kind !== "mcp";
    const execBatch = (commands: Extract<Block, { k: "tool" }>[]) => {
      const callId = id("call");
      const code = `const r = await Promise.allSettled([\n${commands.map((c) => `  ${jsCall(c.call)}`).join(",\n")}\n]);\ntext(JSON.stringify(r));`;
      line("response_item", { type: "custom_tool_call", id: id("ctc"), status: "completed", call_id: callId, name: "exec", input: code });
      record(code.length);
      for (const c of commands) {
        tick(1, 8);
        if (c.call.kind === "web") {
          item({ type: "Extension", kind: "web.search", id: id("ws"), query: c.call.url, action: { type: "openPage", url: c.call.url }, results: [{ type: "text_result", title: "Zero-decimal currencies", url: c.call.url, snippet: c.call.output.slice(0, 120) }] });
        } else {
          const cmd = shellOf(c.call);
          item({ type: "CommandExecution", id: `exec-${rng.hex(8)}`, command: ["/bin/bash", "-lc", cmd], cwd: script.cwd, parsed_cmd: [parsedOf(c.call, cmd)], source: "unified_exec_startup", status: c.call.isError ? "failed" : "completed", aggregated_output: c.call.output, exit_code: c.call.isError ? 1 : 0, duration: { secs: 0, nanos: 1_000_000 } });
        }
        tokens.add(c.call.output.length);
      }
      line("response_item", { type: "custom_tool_call_output", call_id: callId, output: [{ type: "input_text", text: "Script completed\nOutput:\n" }] });
    };
    let batch: Extract<Block, { k: "tool" }>[] = [];
    const flush = () => {
      if (batch.length) execBatch(batch);
      batch = [];
    };
    for (const b of calls) {
      if (b.k === "tool" && isCommand(b)) {
        batch.push(b);
        continue;
      }
      flush();
      if (b.k === "subagent") {
        const callId = id("call");
        const child = `${rng.hex(8)}-${rng.hex(4)}-7${rng.hex(3)}-8${rng.hex(3)}-${rng.hex(12)}`;
        const task = b.call.agents[0]?.toLowerCase().replace(/[^a-z0-9]+/g, "_") || "helper";
        line("response_item", { type: "function_call", name: "spawn_agent", namespace: "collaboration", arguments: JSON.stringify({ task_name: task, message: `gAAAAA${rng.token(200)}` }), call_id: callId });
        record(0);
        item({ type: "SubAgentActivity", id: callId, kind: "started", agent_thread_id: child, agent_path: `/root/${task}`, model, reasoning_effort: effort });
        line("response_item", { type: "function_call_output", call_id: callId, output: JSON.stringify({ agent_path: `/root/${task}` }) });
        tick(20, 90);
        line("response_item", { type: "agent_message", id: id("am"), author: `/root/${task}`, recipient: "/root", content: [{ type: "input_text", text: `Message from /root/${task}` }, { type: "encrypted_content", encrypted_content: `gAAAAA${rng.token(200)}` }] });
        tokens.add(b.call.output.length);
      } else if (b.call.kind === "edit" || b.call.kind === "write") {
        const callId = id("call");
        const rel = (b.call.path ?? "").replace(`${script.cwd}/`, "");
        const patch = b.call.kind === "write" ? `*** Begin Patch\n*** Add File: ${rel}\n${(b.call.content ?? "").split("\n").map((l) => `+${l}`).join("\n")}\n*** End Patch` : `*** Begin Patch\n*** Update File: ${rel}\n@@\n${(b.call.oldText ?? "").split("\n").map((l) => `-${l}`).join("\n")}\n${(b.call.newText ?? "").split("\n").map((l) => `+${l}`).join("\n")}\n*** End Patch`;
        line("response_item", { type: "custom_tool_call", id: id("ctc"), status: "completed", call_id: callId, name: "apply_patch", input: patch });
        record(patch.length);
        tick(1, 5);
        line("response_item", { type: "custom_tool_call_output", call_id: callId, output: `Success. Updated the following files:\n${b.call.kind === "write" ? "A" : "M"} ${rel}` });
      }
    }
    flush();
  };

  const emit = (items: Item[]) => {
    for (const it of items) {
      switch (it.t) {
        case "prompt":
        case "queuedPrompt":
          prompt(it.text, { image: it.t === "prompt" && it.image });
          break;
        case "commandPrompt":
          prompt(`${it.name}${it.args ? ` ${it.args}` : ""}`);
          break;
        case "skill":
          if (it.typed) prompt(`$${it.name}${it.args ? ` ${it.args}` : ""}`, { skill: it.name });
          else respond([{ k: "tool", call: { kind: "read", path: `${opts.home}/.codex/skills/${it.name}/SKILL.md`, output: `# ${it.name}\n\n${it.body}` } }]);
          break;
        case "response":
          respond(it.blocks);
          break;
        case "interrupt":
          event({ type: "turn_aborted", turn_id: turnId, reason: "interrupted" });
          break;
        case "apiError":
          event({ type: "task_complete", turn_id: turnId, last_agent_message: null, error: { message: `unexpected status 529 Overloaded: ${it.text}`, codex_error_info: "other" } });
          break;
        case "compaction": {
          tick(5, 30);
          const responseId = id("resp");
          const u = { input_tokens: tokens.contextTokens, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 900, reasoning_output_tokens: 0, total_tokens: tokens.contextTokens + 900 };
          for (const k of Object.keys(total) as (keyof typeof total)[]) total[k] += u[k];
          line("token_usage_record", { thread_id: opts.sessionId, turn_id: turnId, response_id: responseId, usage: u, thread_token_usage: { ...total } });
          line("compacted", { message: it.summary, compaction_response_id: responseId, replacement_history: [] });
          tokens.compact();
          break;
        }
        case "idle":
          now += it.minutes * 60_000;
          tokens.expireCache();
          break;
        case "modelChange":
          // The script's model names are Claude's; a Codex user switches between OpenAI models.
          model = "gpt-6.2-sol";
          tokens.expireCache();
          break;
        case "thinkingLevel":
          effort = it.level === "off" ? "minimal" : it.level;
          break;
        case "subagentNotice":
          line("response_item", { type: "agent_message", id: id("am"), author: "/root/explorer", recipient: "/root", content: [{ type: "input_text", text: "Message from /root/explorer" }] });
          break;
        case "abandoned":
        case "command":
          break;
      }
    }
  };
  emit(script.items);
  return `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`;
}

/** What a script tool call runs in the shell. */
function shellOf(c: ToolCall): string {
  switch (c.kind) {
    case "read":
      return `sed -n 1,200p ${c.path}`;
    case "grep":
      return `rg -n ${JSON.stringify(c.pattern ?? "")} ${c.path ?? "."}`;
    case "glob":
      return `rg --files -g ${JSON.stringify(c.pattern ?? "*")}`;
    case "bash":
      return c.command ?? "true";
    default:
      return "true";
  }
}

/** `parsed_cmd`, as Codex classifies a command. */
function parsedOf(c: ToolCall, cmd: string): Json {
  if (c.kind === "read") return { type: "read", cmd, name: (c.path ?? "").split("/").at(-1), path: c.path };
  if (c.kind === "grep") return { type: "search", cmd, query: c.pattern, path: c.path };
  if (c.kind === "glob") return { type: "list_files", cmd, path: "." };
  return { type: "unknown", cmd };
}

/** The line of code-mode JavaScript that runs a tool. */
function jsCall(c: ToolCall): string {
  if (c.kind === "web") return `tools.web__run({open: [{ref_id: ${JSON.stringify(c.url)}}]})`;
  return `tools.exec_command({cmd: ${JSON.stringify(shellOf(c))}})`;
}
