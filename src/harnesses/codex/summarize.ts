import { Collector, headOf, lines, parseLine } from "../summary-kit.js";
import type { CodexSidecar } from "./files.js";

/**
 * The browser's index for a Codex rollout. Codex writes `{"timestamp":…,"ordinal":…,"type":…` first on every line, so
 * the kind of a line is in its first few hundred bytes; only prompts, assistant messages, model settings and the
 * header are parsed. Command output (`CommandExecution` items, tool outputs) is the bulk and is skipped unread.
 */
export function summarizeCodex(raw: string, c: Collector, sidecar?: unknown): void {
  const title = (sidecar as CodexSidecar | undefined)?.title;
  if (title) c.title = title;
  for (const line of lines(raw)) {
    const head = headOf(line);
    c.stamp(/^\{"timestamp":"([^"]+)"/.exec(head)?.[1]);
    if (head.includes('"type":"token_usage_record"')) {
      c.calls++;
    } else if (head.includes('"type":"event_msg","payload":{"type":"item_completed"')) {
      if (head.includes('"item":{"type":"UserMessage"')) {
        const e = parseLine(line);
        const content = e?.payload?.item?.content;
        const text = (Array.isArray(content) ? content : []).filter((x: any) => x?.type === "text" && typeof x.text === "string").map((x: any) => x.text).join("\n").trim();
        if (text) c.prompt(text);
      } else if (head.includes('"item":{"type":"CommandExecution"')) c.tool("exec_command");
      else if (head.includes('"item":{"type":"Extension"')) c.tool("web_search");
    } else if (head.includes('"type":"response_item","payload":{"type":"message"') && head.includes('"role":"assistant"')) {
      const content = parseLine(line)?.payload?.content;
      c.say((Array.isArray(content) ? content : []).filter((x: any) => x?.type === "output_text" && typeof x.text === "string").map((x: any) => ({ type: "text", text: x.text })));
    } else if (head.includes('"type":"response_item","payload":{"type":"function_call"') || head.includes('"type":"response_item","payload":{"type":"custom_tool_call"')) {
      const name = /"name":"([^"]{1,80})"/.exec(head)?.[1];
      if (name && name !== "exec") c.tool(name);
    } else if (head.includes('"type":"turn_context"')) {
      const e = parseLine(line);
      c.model(e?.payload?.model);
    } else if (head.includes('"type":"session_meta"')) {
      const e = parseLine(line);
      const p = e?.payload;
      if (p && !c.cwd) {
        if (typeof p.cwd === "string") c.cwd = p.cwd;
        if (typeof p.git?.branch === "string" && p.git.branch) c.branch = p.git.branch;
      }
    }
  }
}
