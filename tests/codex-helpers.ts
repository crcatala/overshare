/**
 * Synthetic Codex rollouts (history mode `paginated`, CLI 0.16x), built in code from the shapes in
 * docs/harnesses/codex.md. Nothing here comes from a real session.
 */
import { randomish } from "./helpers.js";

type Json = Record<string, unknown>;

/** A Fernet-shaped blob like the ones Codex stores encrypted reasoning in, assembled at runtime. */
export const encryptedBlob = (seed = 41, length = 160): string => ["gAAAA", "AB", randomish(length, seed, "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_")].join("");

export const BASE_INSTRUCTIONS = "You are Codex, a coding agent. BASE-INSTRUCTIONS-MARKER";
export const AGENTS_MD = "# AGENTS.md instructions for /home/tester/work/demo\n\nAGENTS-MD-MARKER";
export const DEVELOPER_TEXT = "<permissions instructions>DEVELOPER-MARKER</permissions instructions>";
export const WORLD_STATE_MARKER = "WORLD-STATE-MARKER";

export interface Command {
  cmd: string;
  output?: string;
  exit?: number;
  /** `parsed_cmd` entries; default one `unknown`. */
  parsed?: Json[];
}

export interface Usage {
  input: number;
  cached?: number;
  output?: number;
  reasoning?: number;
}

export class CodexTranscript {
  lines: Json[] = [];
  private ordinal = 0;
  private seconds = 0;
  private seq = 0;
  private turnId = "";
  private total = { input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 0 };
  /** Write `token_usage_record` lines (CLI ≥ 0.154); without them only `token_count` events carry usage. */
  records = true;

  constructor(
    readonly id = "01a0c0de-0000-7000-8000-000000000001",
    readonly cwd = "/home/tester/work/demo",
    opts: { subagent?: { parent: string; task?: string }; branch?: string; cliVersion?: string } = {},
  ) {
    const meta: Json = {
      creator_user_id: "user-ABCDEFGHIJ",
      creator_account_id: "00000000-1111-2222-3333-444444444444",
      session_id: id,
      id,
      timestamp: this.now(),
      cwd,
      originator: "codex_exec",
      cli_version: opts.cliVersion ?? "0.169.0",
      source: opts.subagent ? { subagent: { thread_spawn: { parent_thread_id: opts.subagent.parent, depth: 1 } } } : "exec",
      thread_source: opts.subagent ? "subagent" : "user",
      model_provider: "openai",
      base_instructions: { text: BASE_INSTRUCTIONS },
      history_mode: "paginated",
      git: { commit_hash: "0123456789abcdef0123456789abcdef01234567", branch: opts.branch ?? "feature/demo", repository_url: "https://example.invalid/demo.git" },
      ...(opts.subagent ? { parent_thread_id: opts.subagent.parent, agent_path: `/root/${opts.subagent.task ?? "explorer"}`, agent_nickname: "Explorer" } : {}),
    };
    this.line("session_meta", meta);
  }

  private now(): string {
    this.seconds += 1;
    return new Date(Date.UTC(2026, 0, 1, 0, 0, this.seconds)).toISOString();
  }

  private nextId(prefix: string): string {
    this.seq += 1;
    return `${prefix}_${String(this.seq).padStart(6, "0")}`;
  }

  line(type: string, payload: Json): this {
    this.lines.push({ timestamp: this.now(), ordinal: this.ordinal++, type, payload });
    return this;
  }

  private event(payload: Json): this {
    return this.line("event_msg", payload);
  }

  private item(item: Json): this {
    return this.event({ type: "item_completed", thread_id: this.id, turn_id: this.turnId, item, started_at_ms: 0, completed_at_ms: 0 });
  }

  /** A turn's context: model and effort (plus the permission profile, which must never be copied). */
  turnContext(model = "gpt-6.1-sol", effort = "medium"): this {
    return this.line("turn_context", {
      turn_id: this.turnId,
      cwd: this.cwd,
      approval_policy: "never",
      sandbox_policy: { type: "danger-full-access" },
      model,
      collaboration_mode: { mode: "default", settings: { model, reasoning_effort: effort, developer_instructions: null } },
      effort,
    });
  }

  /**
   * A new turn started by a prompt, as Codex writes it: developer and context messages, the turn context, the typed
   * text twice (model copy and display item), and for a `$skill` prompt the skill's body as another user message.
   */
  user(text: string, opts: { skills?: string[]; images?: number; model?: string; effort?: string; context?: boolean } = {}): this {
    this.turnId = `turn-${this.nextId("t")}`;
    this.event({ type: "task_started", turn_id: this.turnId, started_at: this.seconds });
    if (opts.context !== false) {
      this.line("response_item", { type: "message", role: "developer", content: [{ type: "input_text", text: DEVELOPER_TEXT }], internal_chat_message_metadata_passthrough: { turn_id: this.turnId, content_item_kinds: ["permissions.instructions"] } });
      this.line("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: AGENTS_MD }, { type: "input_text", text: `<environment_context>\n  <cwd>${this.cwd}</cwd>\n</environment_context>` }], internal_chat_message_metadata_passthrough: { turn_id: this.turnId, content_item_kinds: ["agents_md.instructions", "environment_context"] } });
      this.line("world_state", { full: true, state: { agents_md: { text: WORLD_STATE_MARKER } } });
    }
    this.turnContext(opts.model, opts.effort);
    const images = Array.from({ length: opts.images ?? 0 }, () => ({ type: "local_image", path: "/home/tester/work/demo/shot.png" }));
    this.line("response_item", { type: "message", role: "user", content: [{ type: "input_text", text }, ...images.map(() => ({ type: "input_image", image_url: "data:image/png;base64,iVBORw0KGgo=" }))], internal_chat_message_metadata_passthrough: { turn_id: this.turnId, content_item_kinds: ["user.text", ...images.map(() => "user.image")] } });
    const skills = (opts.skills ?? []).map((name) => ({ type: "skill", name, path: `/home/tester/.codex/skills/${name}/SKILL.md` }));
    this.item({ type: "UserMessage", id: this.nextId("um"), content: [{ type: "text", text, text_elements: [] }, ...images, ...skills] });
    for (const s of opts.skills ?? []) {
      this.line("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: `<skill>\n<name>${s}</name>\nSKILL-BODY-MARKER\n</skill>` }], internal_chat_message_metadata_passthrough: { turn_id: this.turnId, content_item_kinds: ["skill.instructions"] } });
    }
    return this;
  }

  /** Assistant text: the model copy and the display item. */
  say(text: string, phase: "commentary" | "final_answer" = "final_answer"): this {
    const id = this.nextId("msg");
    this.item({ type: "AgentMessage", id, content: [{ type: "Text", text }], phase });
    return this.line("response_item", { type: "message", status: "completed", id, role: "assistant", content: [{ type: "output_text", text, annotations: [] }], phase });
  }

  /** A reasoning block: encrypted, with an optional summary. */
  reason(summary?: string, seed = 41): this {
    const id = this.nextId("rs");
    this.item({ type: "Reasoning", id, summary_text: summary ? [summary] : [], raw_content: [] });
    return this.line("response_item", { type: "reasoning", id, summary: summary ? [{ type: "summary_text", text: summary }] : [], encrypted_content: encryptedBlob(seed) });
  }

  /** The usage of one model response (`token_usage_record`, repeated in a `token_count` event). */
  usage(u: Usage): this {
    const usage = { input_tokens: u.input, cached_input_tokens: u.cached ?? 0, cache_write_input_tokens: 0, output_tokens: u.output ?? 0, reasoning_output_tokens: u.reasoning ?? 0, total_tokens: u.input + (u.output ?? 0) };
    for (const k of Object.keys(this.total) as (keyof typeof this.total)[]) this.total[k] += usage[k];
    if (this.records) this.line("token_usage_record", { thread_id: this.id, turn_id: this.turnId, response_id: this.nextId("resp"), usage, turn_token_usage: usage, thread_token_usage: { ...this.total } });
    return this.event({ type: "token_count", info: { total_token_usage: { ...this.total }, last_token_usage: usage, model_context_window: 400_000 }, rate_limits: null });
  }

  /** A rate-limit refresh: a `token_count` with no usage. */
  rateLimits(): this {
    return this.event({ type: "token_count", info: null, rate_limits: { primary: { used_percent: 1 } } });
  }

  /**
   * A code-mode `exec` call: the JavaScript, the response's usage, one `CommandExecution` item per command, and the
   * script's output (which repeats the commands' output).
   */
  exec(commands: Command[], u: Usage = { input: 1_000, cached: 800, output: 50 }, script?: string): this {
    const callId = this.nextId("call");
    const code = script ?? `const r = await Promise.allSettled([\n${commands.map((c) => `  tools.exec_command({cmd: ${JSON.stringify(c.cmd)}})`).join(",\n")}\n]);\ntext(JSON.stringify(r));`;
    this.line("response_item", { type: "custom_tool_call", id: this.nextId("ctc"), status: "completed", call_id: callId, name: "exec", input: code });
    this.usage(u);
    for (const c of commands) {
      this.item({
        type: "CommandExecution",
        id: `exec-${this.nextId("ce")}`,
        process_id: "1234",
        command: ["/bin/bash", "-lc", c.cmd],
        cwd: this.cwd,
        parsed_cmd: c.parsed ?? [{ type: "unknown", cmd: c.cmd }],
        source: "unified_exec_startup",
        status: (c.exit ?? 0) === 0 ? "completed" : "failed",
        aggregated_output: c.output ?? "",
        exit_code: c.exit ?? 0,
        duration: { secs: 0, nanos: 1000 },
      });
    }
    return this.line("response_item", { type: "custom_tool_call_output", id: this.nextId("ctco"), call_id: callId, output: [{ type: "input_text", text: "Script completed\nOutput:\n" }, { type: "input_text", text: JSON.stringify(commands.map((c) => c.output ?? "")) }] });
  }

  /** A web search run from an `exec` call. */
  webSearch(query: string, results: { title: string; url: string }[]): this {
    const callId = this.nextId("call");
    this.line("response_item", { type: "custom_tool_call", id: this.nextId("ctc"), status: "completed", call_id: callId, name: "exec", input: `await tools.web__run({query: ${JSON.stringify(query)}})` });
    this.usage({ input: 900, cached: 800, output: 20 });
    this.item({ type: "Extension", kind: "web.search", id: this.nextId("ws"), query, action: { type: "search", query, queries: null }, results: results.map((r) => ({ type: "text_result", ...r, snippet: "..." })) });
    return this.line("response_item", { type: "custom_tool_call_output", id: this.nextId("ctco"), call_id: callId, output: [{ type: "input_text", text: "Script completed" }] });
  }

  /** A non-code-mode custom tool call (`apply_patch`) and its output. */
  customTool(name: string, input: string, output: string, u: Usage = { input: 1_000, cached: 900, output: 80 }): this {
    const callId = this.nextId("call");
    this.line("response_item", { type: "custom_tool_call", id: this.nextId("ctc"), status: "completed", call_id: callId, name, input });
    this.usage(u);
    return this.line("response_item", { type: "custom_tool_call_output", id: this.nextId("ctco"), call_id: callId, output });
  }

  /** A function call (`shell`, `spawn_agent`, ...) and its output. */
  functionCall(name: string, args: Json, output: string, opts: { namespace?: string; usage?: Usage; success?: boolean; commandItem?: Command } = {}): this {
    const callId = this.nextId("call");
    this.line("response_item", { type: "function_call", status: "completed", id: this.nextId("fc"), name, ...(opts.namespace ? { namespace: opts.namespace } : {}), arguments: JSON.stringify(args), call_id: callId });
    this.usage(opts.usage ?? { input: 1_000, cached: 900, output: 40 });
    if (opts.commandItem) {
      const c = opts.commandItem;
      this.item({ type: "CommandExecution", id: `exec-${this.nextId("ce")}`, command: ["/bin/bash", "-lc", c.cmd], cwd: this.cwd, parsed_cmd: [{ type: "unknown", cmd: c.cmd }], status: "completed", aggregated_output: c.output ?? "", exit_code: c.exit ?? 0 });
    }
    return this.line("response_item", { type: "function_call_output", call_id: callId, output: opts.success === undefined ? output : { content: output, success: opts.success } });
  }

  /**
   * `spawn_agent` as the parent writes it: the call (its message encrypted), the response's usage, the
   * `SubAgentActivity` item naming the new thread, and the call's output.
   */
  spawn(task: string, childId: string): this {
    const callId = this.nextId("call");
    this.line("response_item", { type: "function_call", status: "completed", id: this.nextId("fc"), name: "spawn_agent", namespace: "collaboration", arguments: JSON.stringify({ task_name: task, message: encryptedBlob(57) }), call_id: callId });
    this.usage({ input: 1_000, cached: 900, output: 40 });
    this.item({ type: "SubAgentActivity", id: this.nextId("sa"), kind: "started", agent_thread_id: childId, agent_path: `/root/${task}`, model: "gpt-6.1-sol", reasoning_effort: "medium" });
    return this.line("response_item", { type: "function_call_output", call_id: callId, output: JSON.stringify({ agent_path: `/root/${task}` }) });
  }

  /** From the next line on, this (subagent) rollout is its own: what came before replayed the parent's history. */
  startOwnHistory(): this {
    (this.lines[0]!.payload as Json).subagent_history_start_ordinal = this.ordinal;
    return this;
  }

  /** A compaction checkpoint: the summary that replaced the history, and the replaced history itself. */
  compacted(summary: string): this {
    return this.line("compacted", { message: summary, replacement_history: [{ type: "message", role: "user", content: [{ type: "input_text", text: "REPLACED-HISTORY-MARKER" }] }] });
  }

  /** A subagent's message back to its parent: who sent it, and an encrypted body. */
  agentMessage(author = "/root/explorer"): this {
    return this.line("response_item", { type: "agent_message", id: this.nextId("am"), author, recipient: "/root", content: [{ type: "input_text", text: `Message from ${author}` }, { type: "encrypted_content", encrypted_content: encryptedBlob(43) }] });
  }

  complete(error?: string): this {
    return this.event({ type: "task_complete", turn_id: this.turnId, last_agent_message: null, ...(error ? { error: { message: error, codex_error_info: "other" } } : {}) });
  }

  abort(reason = "interrupted"): this {
    this.line("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "<turn_aborted>The user interrupted.</turn_aborted>" }], internal_chat_message_metadata_passthrough: { turn_id: this.turnId, content_item_kinds: ["generic.turn_aborted"] } });
    return this.event({ type: "turn_aborted", turn_id: this.turnId, reason });
  }

  /** The running total the last `token_count` reported. */
  get totals() {
    return { ...this.total };
  }

  toJsonl(): string {
    return `${this.lines.map((l) => JSON.stringify(l)).join("\n")}\n`;
  }
}
