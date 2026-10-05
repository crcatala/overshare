import { Collector, headOf, lines, parseLine, textOf } from "../summary-kit.js";

export function summarizePi(raw: string, c: Collector): void {
  for (const line of lines(raw)) {
    const head = headOf(line);
    // pi writes `type` first on every line.
    if (head.startsWith('{"type":"message"')) {
      if (head.includes('"role":"toolResult"')) {
        c.stamp(/"timestamp":"([^"]+)"/.exec(head)?.[1]);
        continue;
      }
      const e = parseLine(line);
      if (!e) continue;
      c.stamp(e.timestamp);
      const msg = e.message ?? {};
      if (msg.role === "user") {
        const text = textOf(msg.content).trim();
        if (text) c.prompt(text);
      } else if (msg.role === "assistant") {
        c.model(msg.model);
        c.say(msg.content);
        c.calls++;
        for (const block of Array.isArray(msg.content) ? msg.content : []) if (block?.type === "toolCall") c.tool(block.name);
      }
    } else if (head.startsWith('{"type":"session_info"')) {
      const e = parseLine(line);
      if (typeof e?.name === "string" && e.name) c.title = e.name;
    } else if (head.startsWith('{"type":"session"')) {
      const e = parseLine(line);
      if (e) {
        c.stamp(e.timestamp);
        if (typeof e.cwd === "string") c.cwd = e.cwd;
      }
    } else if (head.startsWith('{"type":"model_change"')) {
      c.model(parseLine(line)?.modelId);
    }
  }
}
