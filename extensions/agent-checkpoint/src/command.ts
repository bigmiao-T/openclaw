import path from "node:path";
import os from "node:os";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { CheckpointEngine } from "./engine.js";
import { getCachedWorkspaceDir } from "./hooks.js";
import { startTimelineServer, type TimelineServer, type TimelineServerParams } from "./timeline-server.js";

/**
 * Register /checkpoint slash command.
 *
 * Usage:
 *   /checkpoint list [agentId] [sessionId]
 *   /checkpoint create [label]
 *   /checkpoint restore <id> [files|transcript|all]
 *   /checkpoint timeline [port]
 *   /checkpoint sessions
 */
export function registerCheckpointCommand(
  api: OpenClawPluginApi,
  engine: CheckpointEngine,
): void {
  let activeServer: TimelineServer | null = null;

  api.registerCommand({
    name: "checkpoint",
    description: "Manage workspace checkpoints (list, create, restore, timeline, sessions).",
    acceptsArgs: true,
    async handler(ctx) {
      const parts = (ctx.args ?? "").trim().split(/\s+/);
      const sub = parts[0] || "sessions";

      // Resolve workspaceDir: cached (from hooks) → config → default
      const defaultAgentId = "main";
      const workspaceDir =
        getCachedWorkspaceDir(defaultAgentId)
        ?? (ctx.config as any)?.agents?.defaults?.workspace
        ?? path.join(os.homedir(), ".openclaw", "workspace");

      if (!workspaceDir) {
        return { text: "No workspace directory available for checkpointing." };
      }

      switch (sub) {
        case "sessions": {
          const sessions = await engine.store.listSessions();
          if (sessions.length === 0) return { text: "No checkpoint sessions found." };

          const lines = sessions.map((s) => {
            const parent = s.parentSession ? ` ← ${s.parentSession.agentId}/${s.parentSession.sessionId}` : "";
            const children = s.childSessions?.length ? ` → ${s.childSessions.length} children` : "";
            return `\`${s.agentId}\` / \`${s.sessionId}\` — ${s.checkpointCount} checkpoints${parent}${children}`;
          });
          return { text: `**Sessions (${sessions.length})**\n${lines.join("\n")}` };
        }

        case "list": {
          const agentId = parts[1] || defaultAgentId;
          const sessionId = parts[2];
          if (!sessionId) {
            return { text: "Usage: /checkpoint list <agentId> <sessionId>\nUse `/checkpoint sessions` to see available sessions." };
          }
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
          const agentId = defaultAgentId;
          const sessionId = "manual";
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
          if (!checkpointId) return { text: "Usage: /checkpoint restore <checkpointId> [files|transcript|all]\nCheckpoint ID contains agentId and sessionId info." };

          // Parse agentId and sessionId from checkpoint ID format: {agent}-{session}-{seq}-{trigger}
          const idParts = checkpointId.split("-");
          if (idParts.length < 4) return { text: "Invalid checkpoint ID format." };
          const agentId = idParts[0]!;
          const sessionId = idParts[1]!;

          // Try to find the checkpoint across all sessions if short sessionId doesn't match
          const sessions = await engine.store.listSessions();
          let resolvedAgentId = agentId;
          let resolvedSessionId = sessionId;
          for (const s of sessions) {
            const cps = await engine.store.listCheckpoints(s.agentId, s.sessionId);
            if (cps.some((cp) => cp.id === checkpointId)) {
              resolvedAgentId = s.agentId;
              resolvedSessionId = s.sessionId;
              break;
            }
          }

          const scopeArg = parts[2] as "files" | "transcript" | "all" | undefined;
          const scope = ["files", "transcript", "all"].includes(scopeArg ?? "")
            ? scopeArg
            : undefined;

          const result = await engine.restoreCheckpoint({
            agentId: resolvedAgentId, sessionId: resolvedSessionId, checkpointId, workspaceDir, scope,
          });
          return { text: `Restored to \`${result.restoredCheckpoint.id}\` (scope: ${result.scope})` };
        }

        case "timeline": {
          if (activeServer) {
            return { text: `Timeline viewer already running at ${activeServer.url}` };
          }
          const port = parts[1] ? Number.parseInt(parts[1], 10) : 0;
          const timelineParams: TimelineServerParams = {
            engine,
            store: engine.store,
            port: Number.isFinite(port) ? port : 0,
            runtime: (api as any).runtime ?? undefined,
          };
          activeServer = await startTimelineServer(timelineParams);
          return { text: `Timeline viewer started at ${activeServer.url}` };
        }

        case "timeline-stop": {
          if (!activeServer) {
            return { text: "No timeline viewer running." };
          }
          await activeServer.close();
          activeServer = null;
          return { text: "Timeline viewer stopped." };
        }

        default:
          return { text: "Usage: /checkpoint [sessions|list <agent> <session>|create [label]|restore <id>|timeline [port]]" };
      }
    },
  });
}
