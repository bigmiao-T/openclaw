import type { OpenClawPluginApi, OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import type { CheckpointEngine } from "./engine.js";
import type { SessionRef } from "./types.js";

/**
 * Workspace directory cache.
 * Keyed by agentId so each agent (including sub-agents) resolves its own workspace.
 */
const workspaceDirs = new Map<string, string>();

/**
 * Maps sessionKey → { agentId, sessionId } for resolving parent/child relationships.
 * Populated from session_start and before_agent_start hooks.
 */
const sessionKeyIndex = new Map<string, SessionRef>();

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
 * - before_agent_start: cache workspaceDir early (before session_start fires)
 * - after_tool_call: auto-create checkpoint for mutating tools
 * - session_start: create baseline checkpoint
 * - subagent_spawned: link parent ↔ child session manifests
 */
export function registerCheckpointHooks(
  api: OpenClawPluginApi,
  engine: CheckpointEngine,
): void {
  // Cache workspaceDir from agent context — fires before session_start,
  // so sub-agents have their workspaceDir ready for the baseline checkpoint.
  api.on("before_agent_start", (_event, context) => {
    if (context.agentId && context.workspaceDir) {
      workspaceDirs.set(context.agentId, context.workspaceDir);
    }
    if (context.agentId && context.sessionId && context.sessionKey) {
      sessionKeyIndex.set(context.sessionKey, {
        agentId: context.agentId,
        sessionId: context.sessionId,
        sessionKey: context.sessionKey,
      });
    }
  });

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

    // Index this session key for parent/child resolution
    if (context.sessionKey) {
      sessionKeyIndex.set(context.sessionKey, {
        agentId,
        sessionId,
        sessionKey: context.sessionKey,
      });
    }

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

  // Link parent ↔ child manifests when a sub-agent is spawned
  api.on("subagent_spawned", async (event, context) => {
    const childSessionKey = event.childSessionKey ?? context.childSessionKey;
    const parentSessionKey = context.requesterSessionKey;
    if (!childSessionKey || !parentSessionKey) return;

    const childRef = sessionKeyIndex.get(childSessionKey)
      ?? parseSessionKey(childSessionKey, event.agentId);
    const parentRef = sessionKeyIndex.get(parentSessionKey);

    if (!parentRef || !childRef) return;

    try {
      await engine.linkParentChild(parentRef, childRef);
    } catch (error) {
      api.logger?.warn(`Failed to link parent/child sessions: ${String(error)}`);
    }
  });
}

/**
 * Best-effort parse of a session key like "agent:main:subagent:uuid" or
 * "agent:main:telegram:chatid" into a SessionRef.
 */
function parseSessionKey(sessionKey: string, fallbackAgentId?: string): SessionRef | undefined {
  // Format: "agent:<agentId>:<type>:<id>" or "agent:<agentId>:<sessionId>"
  const parts = sessionKey.split(":");
  if (parts.length < 3 || parts[0] !== "agent") return undefined;

  const agentId = parts[1]!;
  // The session ID portion is everything after agent:<agentId>:
  // For subagent keys like "agent:main:subagent:uuid", the sessionId is the uuid
  // But we may not have it indexed yet. Use the full key suffix as sessionId fallback.
  const sessionId = parts.slice(2).join(":");

  return { agentId: fallbackAgentId ?? agentId, sessionId, sessionKey };
}
