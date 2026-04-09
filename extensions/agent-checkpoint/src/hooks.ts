import os from "node:os";
import path from "node:path";
import type { OpenClawPluginApi, OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import type { CheckpointEngine } from "./engine.js";
import type { SessionRef } from "./types.js";

function sessionTranscriptPath(agentId: string, sessionId: string): string {
  return path.join(os.homedir(), ".openclaw", "agents", agentId, "sessions", `${sessionId}.jsonl`);
}

/**
 * Encapsulates mutable hook state (workspace dirs, session key index)
 * so it is testable and not hidden in module-level globals.
 */
export class CheckpointHookState {
  /** Workspace directory per agentId. */
  private readonly workspaceDirs = new Map<string, string>();
  /** Maps sessionKey → SessionRef for parent/child resolution. */
  private readonly sessionKeyIndex = new Map<string, SessionRef>();

  cacheWorkspaceDir(ctx: OpenClawPluginToolContext): void {
    if (ctx.agentId && ctx.workspaceDir) {
      this.workspaceDirs.set(ctx.agentId, ctx.workspaceDir);
    }
  }

  getCachedWorkspaceDir(agentId: string): string | undefined {
    return this.workspaceDirs.get(agentId);
  }

  indexSession(agentId: string, sessionId: string, sessionKey: string): void {
    this.sessionKeyIndex.set(sessionKey, { agentId, sessionId, sessionKey });
  }

  getSessionRef(sessionKey: string): SessionRef | undefined {
    return this.sessionKeyIndex.get(sessionKey);
  }
}

type CheckpointContext = { agentId: string; sessionId: string; workspaceDir: string };

/** Extract and validate the checkpoint-relevant fields from a hook context. */
function resolveCheckpointContext(
  context: { agentId?: string; sessionId?: string },
  state: CheckpointHookState,
): CheckpointContext | null {
  const { agentId, sessionId } = context;
  if (!agentId || !sessionId) return null;
  const workspaceDir = state.getCachedWorkspaceDir(agentId);
  if (!workspaceDir) return null;
  return { agentId, sessionId, workspaceDir };
}

/**
 * Register checkpoint hooks:
 * - before_agent_start: cache workspaceDir early (before session_start fires)
 * - before_tool_call: auto-create checkpoint before mutating tools (preserves pre-tool state)
 * - session_start: create baseline checkpoint
 * - subagent_spawned: link parent ↔ child session manifests
 */
export function registerCheckpointHooks(
  api: OpenClawPluginApi,
  engine: CheckpointEngine,
  state: CheckpointHookState,
): void {
  // Cache workspaceDir from agent context — fires before session_start,
  // so sub-agents have their workspaceDir ready for the baseline checkpoint.
  api.on("before_agent_start", (_event, context) => {
    if (context.agentId && context.workspaceDir) {
      state.cacheWorkspaceDir(context as OpenClawPluginToolContext);
    }
    if (context.agentId && context.sessionId && context.sessionKey) {
      state.indexSession(context.agentId, context.sessionId, context.sessionKey);
    }
  });

  api.on("before_tool_call", async (event, context) => {
    const toolName = event.toolName ?? "";
    if (!engine.shouldCreateCheckpoint(toolName)) return;

    const ctx = resolveCheckpointContext(context, state);
    if (!ctx) return;

    try {
      await engine.createCheckpoint({
        agentId: ctx.agentId,
        sessionId: ctx.sessionId,
        runId: (context as any).runId ?? "",
        workspaceDir: ctx.workspaceDir,
        trigger: {
          type: "before_tool_call",
          toolName,
          toolCallId: (context as any).toolCallId,
        },
        sessionTranscriptPath: sessionTranscriptPath(ctx.agentId, ctx.sessionId),
      });
      await engine.pruneExcess(ctx.agentId, ctx.sessionId);
    } catch (error) {
      api.logger?.warn(`Checkpoint failed before ${toolName}: ${String(error)}`);
    }
  });

  api.on("session_start", async (_event, context) => {
    const { agentId, sessionId } = context;
    if (!agentId || !sessionId) return;

    // Index this session key for parent/child resolution
    if (context.sessionKey) {
      state.indexSession(agentId, sessionId, context.sessionKey);
    }

    const workspaceDir = state.getCachedWorkspaceDir(agentId);
    if (!workspaceDir) return;

    try {
      await engine.createCheckpoint({
        agentId,
        sessionId,
        runId: "",
        workspaceDir,
        trigger: { type: "session_start" },
        sessionTranscriptPath: sessionTranscriptPath(agentId, sessionId),
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

    const childRef = state.getSessionRef(childSessionKey)
      ?? parseSessionKey(childSessionKey, event.agentId);
    const parentRef = state.getSessionRef(parentSessionKey);

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
  const sessionId = parts.slice(2).join(":");

  return { agentId: fallbackAgentId ?? agentId, sessionId, sessionKey };
}
