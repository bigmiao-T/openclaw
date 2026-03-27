import type { AnyAgentTool, OpenClawPluginToolContext } from "../api.js";
import type { CheckpointEngine } from "./checkpoint-engine.js";
import type { RestoreScope } from "./types.js";

const RESTORE_SCOPES: RestoreScope[] = ["files", "transcript", "all"];

export function createCheckpointTool(params: {
  engine: CheckpointEngine;
  context: OpenClawPluginToolContext;
}): AnyAgentTool {
  const { engine, context } = params;

  return {
    name: "checkpoint",
    description:
      "Manage workspace checkpoints. Actions: list (show checkpoints), create (manual checkpoint), restore (rollback to a checkpoint).",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "create", "restore"],
          description: "The checkpoint action to perform.",
        },
        checkpoint_id: {
          type: "string",
          description: "Checkpoint ID for restore action.",
        },
        scope: {
          type: "string",
          enum: ["files", "transcript", "all"],
          description:
            "Restore scope: 'files' (workspace only), 'transcript' (conversation only), or 'all' (both). Defaults to 'all'.",
        },
      },
      required: ["action"],
    },
    async execute(args: Record<string, unknown>): Promise<string> {
      const action = String(args.action ?? "list");
      const agentId = context.agentId ?? "unknown";
      const sessionId = context.sessionId ?? "unknown";
      const workspaceDir = context.workspaceDir;

      if (!workspaceDir) {
        return "Error: No workspace directory available.";
      }

      switch (action) {
        case "list": {
          const checkpoints = await engine.listCheckpoints(agentId, sessionId);
          if (checkpoints.length === 0) {
            return "No checkpoints found for this session.";
          }

          const lines = checkpoints.map((cp) => {
            const toolInfo = cp.trigger.toolName ? ` [${cp.trigger.toolName}]` : "";
            const status = cp.toolResult?.success === false ? " (ERROR)" : "";
            const fileCount = cp.git.filesChanged.length;
            return `- ${cp.id} | ${cp.createdAt}${toolInfo}${status} | ${fileCount} files changed`;
          });

          return `Checkpoints (${checkpoints.length}):\n${lines.join("\n")}`;
        }

        case "create": {
          const meta = await engine.createCheckpoint({
            agentId,
            sessionId,
            runId: "",
            workspaceDir,
            trigger: { type: "manual" },
          });

          return `Checkpoint created: ${meta.id} (${meta.git.filesChanged.length} files, ${meta.git.diffStat ?? "no diff"})`;
        }

        case "restore": {
          const checkpointId = args.checkpoint_id;
          if (!checkpointId || typeof checkpointId !== "string") {
            return "Error: checkpoint_id is required for restore action.";
          }

          const rawScope = args.scope;
          const scope: RestoreScope | undefined =
            typeof rawScope === "string" && RESTORE_SCOPES.includes(rawScope as RestoreScope)
              ? (rawScope as RestoreScope)
              : undefined;

          const result = await engine.restoreCheckpoint({
            agentId,
            sessionId,
            checkpointId,
            workspaceDir,
            scope,
          });

          return `Restored to checkpoint ${result.restoredCheckpoint.id} (scope: ${result.scope}, files: ${result.filesRestored}, transcript: ${result.transcriptRestored})`;
        }

        default:
          return `Unknown action: ${action}. Valid actions: list, create, restore.`;
      }
    },
  };
}
