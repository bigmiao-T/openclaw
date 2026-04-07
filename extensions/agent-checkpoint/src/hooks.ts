import type { OpenClawPluginApi, OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import type { CheckpointEngine } from "./engine.js";

/**
 * Workspace directory cache.
 * PluginHookToolContext has no workspaceDir, so we cache it
 * from the tool factory context where it IS available.
 */
const workspaceDirs = new Map<string, string>();

export function cacheWorkspaceDir(ctx: OpenClawPluginToolContext): void {
  if (ctx.agentId && ctx.workspaceDir) {
    workspaceDirs.set(ctx.agentId, ctx.workspaceDir);
  }
}

export function getCachedWorkspaceDir(agentId: string): string | undefined {
  return workspaceDirs.get(agentId);
}

/**
 * Register checkpoint hooks:
 * - after_tool_call: auto-create checkpoint for mutating tools
 * - session_start: create baseline checkpoint
 */
export function registerCheckpointHooks(
  api: OpenClawPluginApi,
  engine: CheckpointEngine,
): void {
  api.on("after_tool_call", async (event, context) => {
    const toolName = event.toolName ?? "";
    if (!engine.shouldCreateCheckpoint(toolName)) return;

    const agentId = context.agentId;
    const sessionId = context.sessionId;
    const runId = context.runId ?? "";
    const workspaceDir = agentId ? getCachedWorkspaceDir(agentId) : undefined;

    if (!agentId || !sessionId || !workspaceDir) return;

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
      api.logger?.warn(`Checkpoint failed after ${toolName}: ${String(error)}`);
    }
  });

  api.on("session_start", async (_event, context) => {
    const agentId = context.agentId;
    const sessionId = context.sessionId;
    if (!agentId || !sessionId) return;

    const workspaceDir = getCachedWorkspaceDir(agentId);
    if (!workspaceDir) return;

    try {
      await engine.createCheckpoint({
        agentId,
        sessionId,
        runId: "",
        workspaceDir,
        trigger: { type: "session_start" },
      });
    } catch (error) {
      api.logger?.warn(`Baseline checkpoint failed: ${String(error)}`);
    }
  });
}
