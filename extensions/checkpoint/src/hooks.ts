import type { OpenClawPluginApi } from "../api.js";
import type { CheckpointEngine } from "./checkpoint-engine.js";
import type { WorkspaceResolver } from "./workspace-resolver.js";

/**
 * Register checkpoint hooks into the plugin API.
 *
 * - `after_tool_call`: Create a checkpoint after each mutating tool call.
 * - `session_start`: Create an initial baseline checkpoint.
 *
 * Note: `PluginHookToolContext` and `PluginHookSessionContext` do not include
 * `workspaceDir`. We use a `WorkspaceResolver` that caches the workspace
 * directory from the tool factory context (`OpenClawPluginToolContext`).
 */
export function registerCheckpointHooks(
  api: OpenClawPluginApi,
  engine: CheckpointEngine,
  workspaceResolver: WorkspaceResolver,
): void {
  // After tool call: create checkpoint if the tool is not excluded
  api.on("after_tool_call", async (event, context) => {
    const toolName = event.toolName ?? "";
    if (!engine.shouldCreateCheckpoint(toolName)) {
      return;
    }

    const agentId = context.agentId;
    const sessionId = context.sessionId;
    const runId = context.runId ?? "";
    const workspaceDir = workspaceResolver.getWorkspaceDir(agentId);

    if (!agentId || !sessionId || !workspaceDir) {
      return;
    }

    try {
      await engine.createCheckpoint({
        agentId,
        sessionId,
        runId,
        workspaceDir,
        trigger: {
          type: "after_tool_call",
          toolName,
          toolCallId: context.toolCallId,
        },
        toolDurationMs: event.durationMs,
        toolResult: event.error
          ? { success: false, errorMessage: String(event.error) }
          : { success: true },
      });
    } catch (error) {
      // Checkpoint failure should not break the agent flow
      api.logger?.warn(`Failed to create checkpoint after ${toolName}: ${String(error)}`);
    }
  });

  // Session start: create baseline checkpoint
  api.on("session_start", async (_event, context) => {
    const agentId = context.agentId;
    const sessionId = context.sessionId;
    const workspaceDir = workspaceResolver.getWorkspaceDir(agentId);

    if (!agentId || !sessionId || !workspaceDir) {
      return;
    }

    try {
      await engine.createCheckpoint({
        agentId,
        sessionId,
        runId: "",
        workspaceDir,
        trigger: { type: "session_start" },
      });
    } catch (error) {
      api.logger?.warn(`Failed to create baseline checkpoint: ${String(error)}`);
    }
  });
}
