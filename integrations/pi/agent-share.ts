/**
 * pi extension: `/share-session [full|brief|minimal]`
 *
 * Shares the live session through the `agent-share` CLI. Unlike a prompt template,
 * the extension knows the exact session file and the current branch leaf, so the
 * export matches what is on screen even in a branched session tree.
 *
 * Install: symlink or copy to ~/.pi/agent/extensions/agent-share.ts
 * Requires `agent-share` on PATH (or set AGENT_SHARE_BIN).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const MODES = ["full", "brief", "minimal"] as const;

interface Report {
  clean: boolean;
  blocked: boolean;
  counts: Record<string, number>;
  findings: { category: string; rule: string; where: string; context: string }[];
  rescan: { rule: string; preview: string }[];
  bytes: number;
}

export default function agentShare(pi: ExtensionAPI) {
  pi.registerCommand("share-session", {
    description: "Share this session (redacted) as an unlisted link: /share-session [full|brief|minimal]",
    getArgumentCompletions: (prefix: string) =>
      MODES.filter((m) => m.startsWith(prefix)).map((m) => ({ value: m, label: m })),
    handler: async (args, ctx) => {
      const mode = (args?.trim() || "brief") as (typeof MODES)[number];
      if (!MODES.includes(mode)) return ctx.ui.notify(`Unknown mode "${mode}" (use full, brief or minimal)`, "error");
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
          .map((f) => `• ${f.rule} @ ${f.where}\n   …${f.context}…`)
          .join("\n");
        const ok = await ctx.ui.confirm(
          "Secrets were redacted — publish anyway?",
          `Redactions: ${counts}\n\n${preview}${secrets.length > 6 ? `\n… ${secrets.length - 6} more` : ""}\n\nThe redacted values are replaced, but review the surrounding context above.`,
        );
        if (!ok) return ctx.ui.notify("Share cancelled.", "info");
        allowFindings = true;
      }

      const publishRun = await pi.exec(bin, ["publish", ...base, "--yes", ...(allowFindings ? ["--allow-findings"] : []), "--json"], {
        timeout: 120_000,
      });
      try {
        const result = JSON.parse(publishRun.stdout) as { viewerUrl: string; url: string };
        ctx.ui.notify(`Shared (${mode}, redactions: ${counts}):\n${result.viewerUrl}\nStored at: ${result.url}`, "info");
      } catch {
        ctx.ui.notify(`agent-share publish failed: ${publishRun.stderr.trim().split("\n").at(-1) ?? `exit ${publishRun.code}`}`, "error");
      }
    },
  });
}
