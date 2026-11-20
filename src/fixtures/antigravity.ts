import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { encode, type Message } from "../harnesses/antigravity/protobuf.js";
import { createDatabase } from "../harnesses/antigravity/sqlite.js";
import type { Rng } from "./random.js";
import type { Block, Item, SessionScript, ToolCall } from "./script.js";
import { TokenModel } from "./tokens.js";

type Json = Record<string, unknown>;

/**
 * Write an Antigravity conversation (ACP 1.5.x layout, as T3 Code runs it) for a script into a data folder:
 * `brain/<id>/.system_generated/logs/transcript_full.jsonl`, the conversation's database (workspace, call ids, usage)
 * and its annotation. Returns the transcript's path. Rewound branches, slash commands and subagents have no
 * Antigravity equivalent here and are left out.
 */
export function writeAntigravity(script: SessionScript, rng: Rng, opts: { dataDir: string; conversationId: string; start: number; home: string }): string {
  const steps: Json[] = [];
  const rows: { idx: number; type: number; status: number; metadata?: Message; payload: Message }[] = [];
  const generations: { lastStep: number }[] = [];
  const tokens = new TokenModel(rng, "openai", 11_000);
  let now = opts.start;
  let idx = 0;
  let model = "gemini-4-neon-high";
  let display = "Gemini 4 Neon (High)";
  const pendingSettings: string[] = [`The user changed setting \`Model Selection\` from None to ${display}. No need to comment on this change if the user doesn't ask about it.`];

  const at = () => new Date(now).toISOString();
  // Where the transcript says its images are: the data folder Antigravity itself would use (fixed, so the output does
  // not depend on where the fixtures are written).
  const media = `${opts.home}/.gemini/antigravity/brain/${opts.conversationId}/.system_generated/logs/media`;
  const tick = (min: number, max: number) => {
    now += rng.int(min, max) * 1000;
  };
  const step = (type: string, source: string, fields: Json, status = "DONE") => {
    const i = idx++;
    steps.push({ step_index: i, source, type, status, created_at: at(), ...fields });
    return i;
  };

  const prompt = (text: string, image?: boolean) => {
    tick(20, 120);
    const settings = pendingSettings.splice(0).map((s) => `\n<USER_SETTINGS_CHANGE>\n${s}\n</USER_SETTINGS_CHANGE>`).join("");
    const content = `<USER_REQUEST>\n${text}\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: ${at()}.\n</ADDITIONAL_METADATA>${settings}`;
    const i = step("USER_INPUT", "USER_EXPLICIT", { content, ...(image ? { media: [{ mime_type: "image/png", uri: `file://${media}/step_${idx}_media_0.png` }] } : {}) });
    rows.push({ idx: i, type: 14, status: 3, payload: [[1, 14]] });
    tokens.add(text.length);
  };

  const respond = (blocks: Block[]) => {
    const visible = blocks.filter((b): b is Extract<Block, { k: "thinking" | "text" | "tool" }> => b.k === "thinking" || b.k === "text" || (b.k === "tool" && b.call.only !== "claude-code" && b.call.kind !== "todo"));
    if (!visible.length) return;
    tick(3, 40);
    const thinking = visible.filter((b) => b.k === "thinking").map((b) => (b.k === "thinking" ? b.text : "")).join("\n\n");
    const thinkingTokens = visible.reduce((n, b) => n + (b.k === "thinking" ? b.tokens : 0), 0);
    const text = visible.filter((b) => b.k === "text").map((b) => (b.k === "text" ? b.text : "")).join("\n\n");
    const calls = visible.filter((b): b is Extract<Block, { k: "tool" }> => b.k === "tool").map((b) => ({ call: b.call, id: `call_${rng.int(1e9, 9e9)}${rng.int(1e8, 9e8)}`, ...toolOf(b.call) }));
    const u = tokens.respond(text.length + thinking.length + JSON.stringify(calls.map((c) => c.args)).length, thinkingTokens);
    const i = step("PLANNER_RESPONSE", "MODEL", {
      model,
      input_tokens: u.input,
      cache_read_tokens: u.cacheRead,
      output_tokens: u.output,
      ...(text ? { content: text } : {}),
      ...(thinking ? { thinking } : {}),
      ...(calls.length ? { tool_calls: calls.map((c) => ({ name: c.name, args: c.args })) } : {}),
    });
    rows.push({
      idx: i,
      type: 15,
      status: 3,
      metadata: [[9, [[1, 1532], [2, u.input], [3, u.output], ...(u.cacheRead ? ([[5, u.cacheRead]] as Message) : []), [9, Math.min(u.reasoning, u.output)], [10, u.output - Math.min(u.reasoning, u.output)]]]],
      payload: [[1, 15], [20, calls.map((c): [number, Message] => [7, [[1, c.id], [2, c.name], [3, JSON.stringify(c.args)]]])]],
    });
    generations.push({ lastStep: i - 1 });
    for (const c of calls) {
      tick(1, 12);
      const r = step("GENERIC", "MODEL", { content: `Created At: ${at()}\nCompleted At: ${at()}\n${c.call.output}`, ...(c.call.image ? { media: [{ mime_type: "image/png", uri: `file://${media}/step_${idx}_media_0.png` }] } : {}) });
      rows.push({ idx: r, type: 132, status: 3, payload: [[1, 132], [5, [[4, [[1, c.id]]]]]] });
      tokens.add(c.call.output.length);
    }
  };

  const emit = (items: Item[]) => {
    for (const it of items) {
      switch (it.t) {
        case "prompt":
        case "queuedPrompt":
          prompt(it.text, it.t === "prompt" && it.image);
          break;
        case "commandPrompt":
          prompt(it.expanded);
          break;
        case "skill":
          if (it.typed) prompt(`${it.name}${it.args ? `: ${it.args}` : ""}`);
          else respond([{ k: "tool", call: { kind: "read", path: `${script.cwd}/.agents/skills/${it.name}/SKILL.md`, output: `# ${it.name}\n\n${it.body}` } }]);
          break;
        case "response":
          respond(it.blocks);
          break;
        case "apiError":
        case "interrupt":
          step("ERROR_MESSAGE", "SYSTEM", { error: "The stream was interrupted. Please continue the task you were working on.", content: "" });
          break;
        case "subagentNotice":
          step("SYSTEM_MESSAGE", "SYSTEM", { content: `The following is a <SYSTEM_MESSAGE> not actually sent by the user.\n\n<SYSTEM_MESSAGE>\n[Message] timestamp=${at()} sender=${opts.conversationId}/task-${rng.int(2, 40)} priority=MESSAGE_PRIORITY_HIGH content=Task id "${opts.conversationId}/task-7" finished: ${it.text.replace(/\*\*/g, "")}\n</SYSTEM_MESSAGE>` });
          break;
        case "modelChange":
          pendingSettings.push(`The user changed setting \`Model Selection\` from ${display} to Gemini 4 Neon (Medium). No need to comment on this change if the user doesn't ask about it.`);
          model = "gemini-4-neon-medium";
          display = "Gemini 4 Neon (Medium)";
          tokens.expireCache();
          break;
        case "idle":
          now += it.minutes * 60_000;
          tokens.expireCache();
          break;
        case "compaction":
          step("CHECKPOINT", "SYSTEM", { content: it.summary });
          tokens.compact();
          break;
        case "thinkingLevel":
        case "abandoned":
        case "command":
          break;
      }
    }
  };
  emit(script.items);

  const generated = join(opts.dataDir, "brain", opts.conversationId, ".system_generated");
  mkdirSync(join(generated, "logs"), { recursive: true });
  const transcript = join(generated, "logs", "transcript_full.jsonl");
  writeFileSync(transcript, `${steps.map((s) => JSON.stringify(s)).join("\n")}\n`);
  mkdirSync(join(opts.dataDir, "annotations"), { recursive: true });
  writeFileSync(join(opts.dataDir, "annotations", `${opts.conversationId}.pbtxt`), `title:${JSON.stringify(script.title)}\n`);
  mkdirSync(join(opts.dataDir, "conversations"), { recursive: true });
  const db = createDatabase(join(opts.dataDir, "conversations", `${opts.conversationId}.db`));
  if (db) {
    db.exec("CREATE TABLE steps (`idx` integer, `step_type` integer NOT NULL DEFAULT 0, `status` integer NOT NULL DEFAULT 0, `metadata` blob, `step_payload` blob, PRIMARY KEY (`idx`))");
    db.exec('CREATE TABLE trajectory_metadata_blob (`id` text DEFAULT "main", `data` blob, PRIMARY KEY (`id`))');
    db.exec("CREATE TABLE gen_metadata (`idx` integer, `data` blob, `size` integer NOT NULL DEFAULT 0, PRIMARY KEY (`idx`))");
    // One transaction: row by row, each insert would sync the file on its own.
    db.exec("BEGIN");
    const insert = db.prepare("INSERT INTO steps (idx, step_type, status, metadata, step_payload) VALUES (?, ?, ?, ?, ?)");
    for (const r of rows) insert.run(r.idx, r.type, r.status, r.metadata ? encode(r.metadata) : null, encode(r.payload));
    const uri = pathToFileURL(script.cwd).href;
    db.prepare("INSERT INTO trajectory_metadata_blob (id, data) VALUES ('main', ?)").run(encode([[1, [[1, uri], [3, [[1, `acme/${script.project}`], [2, `https://example.invalid/acme/${script.project}.git`]]], [4, "fix/invoice-currency"]]], [7, uri]]));
    const gen = db.prepare("INSERT INTO gen_metadata (idx, data) VALUES (?, ?)");
    generations.forEach((g, n) => gen.run(n, encode([[1, [[19, "gemini-4-neon"], [20, [[1, "last_step_index"], [2, String(g.lastStep)]]], [21, display]]]])));
    db.exec("COMMIT");
    db.close();
  }
  return transcript;
}

/** Antigravity's tool for a script call, with its argument keys. */
function toolOf(c: ToolCall): { name: string; args: Json } {
  switch (c.kind) {
    case "read":
      return { name: "read_file", args: { Path: c.path } };
    case "edit":
      return { name: "edit_file", args: { Path: c.path, Target: c.oldText, Replacement: c.newText } };
    case "write":
      return { name: "write_file", args: { Path: c.path, Content: c.content, Overwrite: true } };
    case "bash":
      return { name: "run_command", args: { CommandLine: c.command, WaitMsBeforeAsync: 5000, toolSummary: (c.command ?? "").split(" ").slice(0, 3).join(" ") } };
    case "grep":
      return { name: "grep_search", args: { Query: c.pattern, SearchPath: c.path } };
    case "glob":
      return { name: "find_by_name", args: { Pattern: c.pattern, SearchDirectory: "." } };
    case "web":
      return { name: "read_url_content", args: { Url: c.url } };
    case "mcp":
      return { name: "mcp_github_create_issue", args: { title: "Follow-ups", toolSummary: "Open a tracking issue" } };
    case "todo":
      return { name: "manage_task", args: { Action: "list" } };
  }
}
