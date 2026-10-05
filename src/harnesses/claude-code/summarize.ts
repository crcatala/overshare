import { stripInjectedContext } from "../shared.js";
import { Collector, headOf, lines, parseLine, textOf } from "../summary-kit.js";

export function summarizeClaude(raw: string, c: Collector): void {
  // A reply is written as several lines with the same message id; count each id once.
  const seenCalls = new Set<string>();
  let pendingCommand: string | undefined;
  for (const line of lines(raw)) {
    const head = headOf(line);
    // Bookkeeping lines (`{"type":"ai-title",…}`, modes, snapshots) lead with `type`; messages lead with `parentUuid`.
    if (head.startsWith('{"type":"') && !head.startsWith('{"type":"user","') && !head.startsWith('{"type":"assistant","')) {
      if (head.startsWith('{"type":"ai-title"')) {
        const e = parseLine(line);
        if (typeof e?.aiTitle === "string" && e.aiTitle) c.title = e.aiTitle;
      } else if (head.startsWith('{"type":"custom-title"')) {
        const e = parseLine(line);
        if (typeof e?.customTitle === "string" && e.customTitle) c.title = e.customTitle;
      }
      continue;
    }
    // Assistant lines lead with `message:{model,…}`; user lines carry `message:{role:"user"}`.
    const isAssistant = head.includes('"message":{"model"') || head.includes('"role":"assistant"');
    const isUser = !isAssistant && head.includes('"message":{"role":"user"');
    if (!isUser && !isAssistant) continue;
    if (head.includes('"isSidechain":true')) continue;
    if (isUser && head.includes('"type":"tool_result"')) {
      // Tool results are the bulk of a transcript and carry nothing we index.
      c.stamp(/"timestamp":"([^"]+)"/.exec(line.slice(-400))?.[1]);
      continue;
    }
    const e = parseLine(line);
    if (!e) continue;
    c.stamp(e.timestamp);
    if (typeof e.cwd === "string") c.cwd ??= e.cwd;
    if (typeof e.gitBranch === "string" && e.gitBranch !== "HEAD") c.branch = e.gitBranch;

    if (isAssistant) {
      const msg = e.message ?? {};
      c.model(msg.model);
      if (msg.model !== "<synthetic>") c.say(msg.content);
      const id = msg.id ?? e.uuid;
      if (msg.model !== "<synthetic>" && id && !seenCalls.has(id)) {
        seenCalls.add(id);
        c.calls++;
      }
      for (const block of Array.isArray(msg.content) ? msg.content : []) if (block?.type === "tool_use") c.tool(block.name);
      continue;
    }

    if (e.isMeta || e.isCompactSummary) continue;
    const origin = e.origin;
    if (origin && typeof origin === "object" && origin.kind !== "human") continue;
    const text = textOf(e.message?.content);
    const name = /<command-name>([\s\S]*?)<\/command-name>/.exec(text)?.[1]?.trim();
    if (name) {
      const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1]?.trim();
      pendingCommand = `${name.startsWith("/") ? name : `/${name}`}${args ? ` ${args}` : ""}`;
      c.prompt(pendingCommand);
      continue;
    }
    if (text.includes("<local-command-stdout>") || /^\[Request interrupted by user/.test(text.trim())) continue;
    const clean = stripInjectedContext(text);
    if (!clean) continue;
    // A command's expansion follows it as a meta line (skipped above); a prompt typed after it stands alone.
    c.prompt(clean);
  }
}
