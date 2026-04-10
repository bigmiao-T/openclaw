import os from "node:os";
import path from "node:path";
import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import type { CheckpointEngine } from "./engine.js";
import { buildContinuationContext } from "./restore-context.js";
import type { RestoreScope } from "./types.js";

const RESTORE_SCOPES: RestoreScope[] = ["files", "transcript", "all"];

const CheckpointParams = {
  type: "object" as const,
  properties: {
    action: {
      type: "string" as const,
      enum: ["list", "create", "restore", "restore_and_continue"],
      description:
        "The checkpoint action to perform. Use restore_and_continue to restore and get rich context for continuing the task.",
    },
    checkpoint_id: {
      type: "string" as const,
      description: "Checkpoint ID for restore action.",
    },
    scope: {
      type: "string" as const,
      enum: ["files", "transcript", "all"],
      description: "Restore scope: files, transcript, or all.",
    },
  },
  required: ["action"],
};

type CheckpointArgs = {
  action?: "list" | "create" | "restore" | "restore_and_continue";
  checkpoint_id?: string;
  scope?: "files" | "transcript" | "all";
};

export function createCheckpointTool(params: {
  engine: CheckpointEngine;
  context: OpenClawPluginToolContext;
  resolveTranscriptPath?: (agentId: string, sessionId: string) => string;
  onTranscriptRestored?: (agentId: string, sessionId: string, newTranscriptPath: string) => Promise<void>;
}) {
  const { engine, context } = params;

  return {
    name: "checkpoint",
    label: "Checkpoint",
    description:
      "Manage workspace checkpoints. Actions: list (show checkpoints), create (manual checkpoint), restore (rollback to a checkpoint), restore_and_continue (restore and get context to continue the task).",
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
            return `- ${cp.id} | ${cp.createdAt}${toolInfo} | ${cp.snapshot.filesChanged.length} files`;
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

          const sessionTranscriptPath = params.resolveTranscriptPath
            ? params.resolveTranscriptPath(agentId, sessionId)
            : path.join(os.homedir(), ".openclaw", "agents", agentId, "sessions", `${sessionId}.jsonl`);
          const result = await engine.restoreCheckpoint({
            agentId,
            sessionId,
            checkpointId,
            workspaceDir,
            scope,
            sessionTranscriptPath,
            onTranscriptRestored: params.onTranscriptRestored
              ? (newPath) => params.onTranscriptRestored!(agentId, sessionId, newPath)
              : undefined,
          });

          return {
            content: [{ type: "text" as const, text: `Restored to ${result.restoredCheckpoint.id} (scope: ${result.scope}, files: ${result.filesRestored}, transcript: ${result.transcriptRestored})${result.transcriptRestored ? "\nNote: Please refresh the dashboard to see the restored conversation." : ""}` }],
            details: { action, checkpointId, scope: result.scope },
          };
        }

        case "restore_and_continue": {
          const checkpointId = args.checkpoint_id;
          if (!checkpointId) {
            return {
              content: [{ type: "text" as const, text: "Error: checkpoint_id is required for restore_and_continue." }],
              details: { action, error: true },
            };
          }

          const rawScope = args.scope;
          const scope: RestoreScope | undefined =
            rawScope && RESTORE_SCOPES.includes(rawScope as RestoreScope)
              ? (rawScope as RestoreScope)
              : undefined;

          const sessionTranscriptPath2 = params.resolveTranscriptPath
            ? params.resolveTranscriptPath(agentId, sessionId)
            : path.join(os.homedir(), ".openclaw", "agents", agentId, "sessions", `${sessionId}.jsonl`);
          const result = await engine.restoreCheckpoint({
            agentId,
            sessionId,
            checkpointId,
            workspaceDir,
            scope,
            sessionTranscriptPath: sessionTranscriptPath2,
            onTranscriptRestored: params.onTranscriptRestored
              ? (newPath) => params.onTranscriptRestored!(agentId, sessionId, newPath)
              : undefined,
          });

          const continuation = buildContinuationContext({
            checkpoint: result.restoredCheckpoint,
            diff: result.diff,
            scope: result.scope,
            filesRestored: result.filesRestored,
            transcriptRestored: result.transcriptRestored,
          });

          return {
            content: [{ type: "text" as const, text: continuation.agentPrompt }],
            details: { action, checkpointId, scope: result.scope },
          };
        }

        default:
          return {
            content: [{ type: "text" as const, text: `Unknown action: ${action}. Valid: list, create, restore, restore_and_continue.` }],
            details: { action, error: true },
          };
      }
    },
  };
}
