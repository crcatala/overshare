import { Collector, lines, parseLine } from "../summary-kit.js";
import { projectWorkspace, type AntigravitySidecar } from "./files.js";
import { unwrapPrompt } from "./parse.js";

/**
 * The browser's index for an Antigravity transcript: prompts (what the user typed), model responses, tool names and
 * the last reply. Tool results (`GENERIC`, the bulk) are skipped unparsed; working directory and title come from the
 * sidecar (the conversation's database and annotation).
 */
export function summarizeAntigravity(raw: string, c: Collector, sidecar?: unknown): void {
  const side = (sidecar ?? {}) as AntigravitySidecar;
  if (side.title) c.title = side.title;
  const workspace = projectWorkspace(Array.isArray(side.workspaces) ? side.workspaces : []);
  if (workspace) {
    c.cwd = workspace.path;
    if (workspace.branch) c.branch = workspace.branch;
  }
  for (const line of lines(raw)) {
    c.stamp(/"created_at":"([^"]+)"/.exec(line.slice(0, 400))?.[1]);
    if (line.includes('"type":"GENERIC"') && !line.includes('"type":"PLANNER_RESPONSE"')) continue;
    const e = parseLine(line);
    if (!e || typeof e.type !== "string") continue;
    if (e.type === "USER_INPUT" && typeof e.content === "string") {
      const { text } = unwrapPrompt(e.content);
      if (text) c.prompt(text);
    } else if (e.type === "PLANNER_RESPONSE") {
      c.calls++;
      c.model(e.model);
      if (typeof e.content === "string") c.say([{ type: "text", text: e.content }]);
      for (const call of Array.isArray(e.tool_calls) ? e.tool_calls : []) c.tool(call?.name);
    }
  }
}
