import { Type, type Static } from "@sinclair/typebox";
import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import type { CheckpointEngine } from "./engine.js";
import type { RestoreScope } from "./types.js";

const RESTORE_SCOPES: RestoreScope[] = ["files", "transcript", "all"];

const CheckpointParams = Type.Object({
  action: Type.Unsafe<"list" | "create" | "restore">({
    type: "string",
    enum: ["list", "create", "restore"],
    description: "The checkpoint action to perform.",
  }),
  checkpoint_id: Type.Optional(Type.String({ description: "Checkpoint ID for restore action." })),
  scope: Type.Optional(
    Type.Unsafe<"files" | "transcript" | "all">({
      type: "string",
      enum: ["files", "transcript", "all"],
      description: "Restore scope: files, transcript, or all.",
    }),
  ),
});

type CheckpointArgs = Static<typeof CheckpointParams>;

export function createCheckpointTool(params: {
  engine: CheckpointEngine;
  context: OpenClawPluginToolContext;
}) {
  const { engine, context } = params;

  return {
    name: "checkpoint",
    label: "Checkpoint",
    description:
      "Manage workspace checkpoints. Actions: list (show checkpoints), create (manual checkpoint), restore (rollback to a checkpoint).",
    parameters: CheckpointParams,

    async execute(toolCallId: string, args: CheckpointArgs) {
      const action = args.action ?? "list";
      const agentId = context.agentId ?? "unknown";
      const sessionId = context.sessionId ?? "unknown";
      const workspaceDir = context.workspaceDir;

      if (!workspaceDir) {
        return {
          content: [{ type: "text" as const, text: "Error: No workspace directory available." }],
          details: { action, error: true },
        };
      }

      switch (action) {
        case "list": {
          const checkpoints = await engine.store.listCheckpoints(agentId, sessionId);
          if (checkpoints.length === 0) {
            return {
              content: [{ type: "text" as const, text: "No checkpoints found for this session." }],
              details: { action, count: 0 },
            };
          }

          const lines = checkpoints.map((cp) => {
            const toolInfo = cp.trigger.toolName ? ` [${cp.trigger.toolName}]` : "";
            const status = cp.toolResult?.success === false ? " (ERROR)" : "";
            return `- ${cp.id} | ${cp.createdAt}${toolInfo}${status} | ${cp.snapshot.filesChanged.length} files`;
          });

          return {
            content: [{ type: "text" as const, text: `Checkpoints (${checkpoints.length}):\n${lines.join("\n")}` }],
            details: { action, count: checkpoints.length },
          };
        }

        case "create": {
          const meta = await engine.createCheckpoint({
            agentId,
            sessionId,
            runId: "",
            workspaceDir,
            trigger: { type: "manual" },
          });

          return {
            content: [{ type: "text" as const, text: `Checkpoint created: ${meta.id} (${meta.snapshot.filesChanged.length} files, ${meta.snapshot.changeSummary ?? "no changes"})` }],
            details: { action, checkpointId: meta.id },
          };
        }

        case "restore": {
          const checkpointId = args.checkpoint_id;
          if (!checkpointId) {
            return {
              content: [{ type: "text" as const, text: "Error: checkpoint_id is required for restore." }],
              details: { action, error: true },
            };
          }

          const rawScope = args.scope;
          const scope: RestoreScope | undefined =
            rawScope && RESTORE_SCOPES.includes(rawScope as RestoreScope)
              ? (rawScope as RestoreScope)
              : undefined;

          const result = await engine.restoreCheckpoint({
            agentId,
            sessionId,
            checkpointId,
            workspaceDir,
            scope,
          });

          return {
            content: [{ type: "text" as const, text: `Restored to ${result.restoredCheckpoint.id} (scope: ${result.scope}, files: ${result.filesRestored}, transcript: ${result.transcriptRestored})` }],
            details: { action, checkpointId, scope: result.scope },
          };
        }

        default:
          return {
            content: [{ type: "text" as const, text: `Unknown action: ${action}. Valid: list, create, restore.` }],
            details: { action, error: true },
          };
      }
    },
  };
}
