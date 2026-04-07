import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { CheckpointEngine } from "./engine.js";
import { getCachedWorkspaceDir } from "./hooks.js";

/**
 * Register /checkpoint slash command.
 *
 * Usage:
 *   /checkpoint list
 *   /checkpoint create [label]
 *   /checkpoint restore <id> [files|transcript|all]
 */
export function registerCheckpointCommand(
  api: OpenClawPluginApi,
  engine: CheckpointEngine,
): void {
  api.registerCommand({
    name: "checkpoint",
    description: "Manage workspace checkpoints (list, create, restore).",
    acceptsArgs: true,
    async handler(ctx) {
      const parts = (ctx.args ?? "").trim().split(/\s+/);
      const sub = parts[0] || "list";
      const agentId = ctx.sessionKey ?? "main";
      const sessionId = ctx.sessionId ?? "unknown";
      const workspaceDir = getCachedWorkspaceDir(agentId);

      if (!workspaceDir) {
        return { text: "No workspace directory available for checkpointing." };
      }

      switch (sub) {
        case "list": {
          const checkpoints = await engine.store.listCheckpoints(agentId, sessionId);
          if (checkpoints.length === 0) return { text: "No checkpoints for this session." };

          const lines = checkpoints.map((cp) => {
            const tool = cp.trigger.toolName ? ` [${cp.trigger.toolName}]` : "";
            const err = cp.toolResult?.success === false ? " \u274c" : "";
            return `\`${cp.id}\` ${cp.createdAt}${tool}${err} — ${cp.snapshot.filesChanged.length} files`;
          });
          return { text: `**Checkpoints (${checkpoints.length})**\n${lines.join("\n")}` };
        }

        case "create": {
          const label = parts.slice(1).join(" ") || undefined;
          const meta = await engine.createCheckpoint({
            agentId,
            sessionId,
            runId: "",
            workspaceDir,
            trigger: { type: "manual", toolName: label },
          });
          return { text: `Checkpoint created: \`${meta.id}\` (${meta.snapshot.filesChanged.length} files)` };
        }

        case "restore": {
          const checkpointId = parts[1];
          if (!checkpointId) return { text: "Usage: /checkpoint restore <id> [files|transcript|all]" };

          const scopeArg = parts[2] as "files" | "transcript" | "all" | undefined;
          const scope = ["files", "transcript", "all"].includes(scopeArg ?? "")
            ? scopeArg
            : undefined;

          const result = await engine.restoreCheckpoint({
            agentId, sessionId, checkpointId, workspaceDir, scope,
          });
          return { text: `Restored to \`${result.restoredCheckpoint.id}\` (scope: ${result.scope})` };
        }

        default:
          return { text: "Usage: /checkpoint [list|create|restore <id>]" };
      }
    },
  });
}
