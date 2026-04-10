import path from "node:path";
import os from "node:os";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { CheckpointEngine } from "./engine.js";
import type { CheckpointHookState } from "./hooks.js";
import { buildContinuationContext } from "./restore-context.js";
import { startTimelineServer, type TimelineServer, type TimelineServerParams } from "./timeline-server.js";

/**
 * Register /checkpoint slash command.
 *
 * Usage:
 *   /checkpoint list [agentId] [sessionId]
 *   /checkpoint create [label]
 *   /checkpoint restore <id> [files|transcript|all]
 *   /checkpoint delete <id>
 *   /checkpoint delete-session <agentId> <sessionId>
 *   /checkpoint delete-before <date>
 *   /checkpoint delete-all
 *   /checkpoint timeline [port]
 *   /checkpoint sessions
 */
export function registerCheckpointCommand(
  api: OpenClawPluginApi,
  engine: CheckpointEngine,
  hookState: CheckpointHookState,
  resolveTranscriptPath?: (agentId: string, sessionId: string) => string,
  onTranscriptRestored?: (agentId: string, sessionId: string, newTranscriptPath: string) => Promise<void>,
): void {
  let activeServer: TimelineServer | null = null;

  api.registerCommand({
    name: "checkpoint",
    description: "Manage workspace checkpoints (list, create, restore, delete, timeline, sessions).",
    acceptsArgs: true,
    async handler(ctx) {
      const parts = (ctx.args ?? "").trim().split(/\s+/);
      const sub = parts[0] || "sessions";

      // Resolve workspaceDir: cached (from hooks) → config → default
      const defaultAgentId = "main";
      const workspaceDir =
        hookState.getCachedWorkspaceDir(defaultAgentId)
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
            return `\`${cp.id}\` ${cp.createdAt}${tool} — ${cp.snapshot.filesChanged.length} files`;
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
          if (!meta) return { text: "Checkpoint skipped — no files changed." };
          return { text: `Checkpoint created: \`${meta.id}\` (${meta.snapshot.filesChanged.length} files)` };
        }

        case "restore": {
          const checkpointId = parts[1];
          if (!checkpointId) return { text: "Usage: /checkpoint restore <checkpointId> [files|transcript|all]" };

          const found = await engine.store.findCheckpoint(checkpointId);
          if (!found) return { text: `Checkpoint not found: \`${checkpointId}\`` };

          const scopeArg = parts[2] as "files" | "transcript" | "all" | undefined;
          const scope = ["files", "transcript", "all"].includes(scopeArg ?? "")
            ? scopeArg
            : undefined;

          const sessionTranscriptPath = resolveTranscriptPath
            ? resolveTranscriptPath(found.agentId, found.sessionId)
            : path.join(os.homedir(), ".openclaw", "agents", found.agentId, "sessions", `${found.sessionId}.jsonl`);
          const result = await engine.restoreCheckpoint({
            agentId: found.agentId, sessionId: found.sessionId, checkpointId, workspaceDir, scope,
            sessionTranscriptPath,
            onTranscriptRestored: onTranscriptRestored
              ? (newPath) => onTranscriptRestored(found.agentId, found.sessionId, newPath)
              : undefined,
          });

          const continuation = buildContinuationContext({
            checkpoint: result.restoredCheckpoint,
            diff: result.diff,
            scope: result.scope,
            filesRestored: result.filesRestored,
            transcriptRestored: result.transcriptRestored,
          });

          return { text: continuation.summary };
        }

        case "delete": {
          const checkpointId = parts[1];
          if (!checkpointId) return { text: "Usage: /checkpoint delete <checkpointId>" };

          const found = await engine.store.findCheckpoint(checkpointId);
          if (!found) return { text: `Checkpoint not found: \`${checkpointId}\`` };

          await engine.deleteCheckpoint(found.agentId, found.sessionId, checkpointId);
          return { text: `Deleted checkpoint \`${checkpointId}\`` };
        }

        case "delete-session": {
          const agentId = parts[1];
          const sessionId = parts[2];
          if (!agentId || !sessionId) {
            return { text: "Usage: /checkpoint delete-session <agentId> <sessionId>\nUse `/checkpoint sessions` to see available sessions." };
          }
          const deleted = await engine.deleteSession(agentId, sessionId);
          return { text: `Deleted ${deleted} checkpoints from session \`${agentId}/${sessionId}\`` };
        }

        case "delete-before": {
          const dateStr = parts[1];
          if (!dateStr) return { text: "Usage: /checkpoint delete-before <date>\nExamples: `2026-04-01`, `2026-04-07T12:00:00`" };

          const cutoff = new Date(dateStr);
          if (Number.isNaN(cutoff.getTime())) return { text: `Invalid date: \`${dateStr}\`` };

          const deleted = await engine.deleteBefore(cutoff);
          return { text: `Deleted ${deleted} checkpoints created before ${cutoff.toISOString()}` };
        }

        case "delete-all": {
          const deleted = await engine.deleteAll();
          return { text: `Deleted all checkpoints (${deleted} total)` };
        }

        case "timeline": {
          if (activeServer) {
            return { text: `Timeline viewer already running at ${activeServer.url}` };
          }
          const port = parts[1] ? Number.parseInt(parts[1], 10) : 0;
          const timelineParams: TimelineServerParams = {
            engine,
            store: engine.store,
            hookState,
            port: Number.isFinite(port) ? port : 0,
            resolveTranscriptPath,
            onTranscriptRestored,
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
          return { text: "Usage: /checkpoint [sessions|list|create|restore|delete|delete-session|delete-before|delete-all|timeline]" };
      }
    },
  });
}
