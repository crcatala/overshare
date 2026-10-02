/**
 * pi extension: `/share-session [full|brief|minimal|prompts]`
 *
 * Shares the live session through the `agent-share` CLI. Unlike a prompt template,
 * the extension knows the exact session file and the current branch leaf, so the
 * export matches what is on screen even in a branched session tree.
 *
 * Install: symlink or copy to ~/.pi/agent/extensions/agent-share.ts
 * Requires `agent-share` on PATH (or set AGENT_SHARE_BIN).
 */
import { createHash } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const MODES = ["full", "brief", "minimal", "prompts"] as const;

interface Report {
  clean: boolean;
  blocked: boolean;
  counts: Record<string, number>;
  findings: { category: string; rule: string; where: string }[];
  rescan: { rule: string; length?: number }[];
  bytes: number;
}

export default function agentShare(pi: ExtensionAPI) {
  // Pi persists expanded template/skill text, not the command the user typed.
  // Idle inputs use input → before_agent_start → user message. Queued inputs have
  // no expansion hook, so only an exact, unambiguous unchanged-text match is safe.
  // Extension-injected/unmatched inputs remain unverified; never guess expansions.
  type CapturedInput = { text: string; source: "interactive" | "rpc"; file: string; expanded?: string };
  let input: CapturedInput | undefined;
  let queued: CapturedInput[] = [];
  const resetInput = () => { input = undefined; queued = []; };
  pi.on("session_start", resetInput);
  pi.on("session_tree", resetInput);
  pi.on("session_shutdown", resetInput);
  pi.on("agent_end", () => { input = undefined; });
  pi.on("input", (event, ctx) => {
    const file = ctx.sessionManager.getSessionFile();
    if (file && event.source !== "extension") {
      const captured = { text: event.text, source: event.source, file };
      if (event.streamingBehavior) {
        queued.push(captured);
        queued = queued.slice(-64); // Dropped captures fail closed, not guessed.
      } else {
        input = ctx.isIdle() ? captured : undefined;
      }
    } else input = undefined;
    return { action: "continue" };
  });
  pi.on("before_agent_start", (event, ctx) => {
    if (input?.file === ctx.sessionManager.getSessionFile()) input.expanded = event.prompt;
    else resetInput();
  });
  pi.on("message_end", (event, ctx) => {
    if (event.message.role !== "user") return;
    const file = ctx.sessionManager.getSessionFile();
    const text = typeof event.message.content === "string" ? event.message.content : event.message.content
      .filter((b) => b.type === "text").map((b) => b.text).join("\n");
    let captured = input?.file === file && input.expanded === text ? input : undefined;
    input = undefined; // One input can certify exactly one message.
    if (!captured) {
      const matches = queued.filter((q) => q.file === file && q.text === text);
      queued = queued.filter((q) => !matches.includes(q));
      if (matches.length === 1) captured = matches[0];
    }
    if (!captured) return;
    // message_end precedes native persistence. This custom entry must be the user
    // message's immediate parent; timestamp + hash prevent reuse/misassociation.
    pi.appendEntry("agent-share:authored-input", {
      version: 1,
      text: captured.text,
      source: captured.source,
      messageTimestamp: event.message.timestamp,
      messageHash: createHash("sha256").update(text).digest("hex"),
    });
  });

  pi.registerCommand("share-session", {
    description: "Share this session (redacted) as an unlisted link: /share-session [full|brief|minimal|prompts]",
    getArgumentCompletions: (prefix: string) =>
      MODES.filter((m) => m.startsWith(prefix)).map((m) => ({ value: m, label: m })),
    handler: async (args, ctx) => {
      const mode = (args?.trim() || "brief") as (typeof MODES)[number];
      if (!MODES.includes(mode)) return ctx.ui.notify(`Unknown mode "${mode}" (use full, brief, minimal or prompts)`, "error");
      const file = ctx.sessionManager.getSessionFile();
      if (!file) return ctx.ui.notify("This session is not saved to a file, so it cannot be shared.", "error");
      const leaf = ctx.sessionManager.getLeafId();
      const bin = process.env.AGENT_SHARE_BIN ?? "agent-share";
      const base = [file, "--harness", "pi", "--mode", mode, ...(leaf ? ["--leaf", leaf] : [])];

      const reportRun = await pi.exec(bin, ["report", ...base, "--json"], { timeout: 120_000 });
      let report: Report;
      try {
        report = JSON.parse(reportRun.stdout) as Report;
      } catch {
        return ctx.ui.notify(`agent-share report failed: ${reportRun.stderr.trim() || `exit ${reportRun.code}`}`, "error");
      }
      if (report.blocked) {
        return ctx.ui.notify(
          `Not shared: the final re-scan found unredacted secrets (${report.rescan.map((r) => r.rule).join(", ")}). Run \`agent-share report\` for details.`,
          "error",
        );
      }
      const counts = Object.entries(report.counts).map(([k, n]) => `${n} ${k}`).join(", ") || "none";
      let allowFindings = false;
      if (!report.clean) {
        const secrets = report.findings.filter((f) => f.category === "known-secret" || f.category === "secret-pattern");
        const preview = secrets
          .slice(0, 6)
          .map((f) => `• ${f.rule} @ ${f.where}`)
          .join("\n");
        const ok = await ctx.ui.confirm(
          "Secrets were redacted — publish anyway?",
          `Redactions: ${counts}\n\n${preview}${secrets.length > 6 ? `\n… ${secrets.length - 6} more` : ""}\n\nThe redacted values are replaced. Review the session itself for anything that was not recognized: the report does not show the text around a finding.`,
        );
        if (!ok) return ctx.ui.notify("Share cancelled.", "info");
        allowFindings = true;
      }

      const publishRun = await pi.exec(bin, ["publish", ...base, "--yes", ...(allowFindings ? ["--allow-findings"] : []), "--json"], {
        timeout: 120_000,
      });
      try {
        const result = JSON.parse(publishRun.stdout) as { viewerUrl: string; url: string; warnings?: string[] };
        ctx.ui.notify(`Shared (${mode}, redactions: ${counts}):\n${result.viewerUrl}\nStored at: ${result.url}`, "info");
        // e.g. bucket not public / CORS missing / default viewer: the link may not load.
        for (const w of result.warnings ?? []) ctx.ui.notify(`agent-share: ${w}`, "warning");
      } catch {
        ctx.ui.notify(`agent-share publish failed: ${publishRun.stderr.trim().split("\n").at(-1) ?? `exit ${publishRun.code}`}`, "error");
      }
    },
  });
}
