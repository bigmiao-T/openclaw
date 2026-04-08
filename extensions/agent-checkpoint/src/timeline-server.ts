import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { CheckpointEngine } from "./engine.js";
import type { CheckpointHookState } from "./hooks.js";
import type { CheckpointStore } from "./store.js";
import { TIMELINE_HTML } from "./timeline-html.js";

export type TimelineServerParams = {
  engine: CheckpointEngine;
  store: CheckpointStore;
  hookState: CheckpointHookState;
  runtime?: {
    subagent: {
      run: (params: { sessionKey: string; message: string; extraSystemPrompt?: string }) => Promise<{ runId: string }>;
      waitForRun: (params: { runId: string; timeoutMs?: number }) => Promise<{ status: "ok" | "error" | "timeout"; error?: string }>;
      getSessionMessages: (params: { sessionKey: string; limit?: number }) => Promise<{ messages: unknown[] }>;
    };
  };
  port?: number;
  hostname?: string;
};

export type TimelineServer = {
  url: string;
  close: () => Promise<void>;
};

/**
 * Starts a local HTTP server that serves a timeline viewer UI
 * plus a JSON API for checkpoint data.
 */
export async function startTimelineServer(params: TimelineServerParams): Promise<TimelineServer> {
  const { engine, store, hookState, runtime } = params;
  const port = params.port ?? 0; // 0 = OS picks an available port
  const hostname = params.hostname ?? "127.0.0.1";

  function getWorkspaceDir(): string {
    const cached = hookState.getCachedWorkspaceDir("main");
    if (cached) return cached;
    return path.join(os.homedir(), ".openclaw", "workspace");
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${hostname}`);
    const pathname = url.pathname;

    // CORS for local dev
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      if (pathname === "/" || pathname === "/index.html") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(TIMELINE_HTML);
        return;
      }

      if (pathname === "/api/sessions") {
        const sessions = await store.listSessions();
        // Enrich with manifest data (parentSession, childSessions, checkpoint count)
        const enriched = await Promise.all(
          sessions.map(async (s) => {
            const manifest = await store.getManifest(s.agentId, s.sessionId);
            return {
              ...s,
              checkpointCount: manifest?.checkpoints.length ?? 0,
              parentSession: manifest?.parentSession ?? null,
              childSessions: manifest?.childSessions ?? [],
            };
          }),
        );
        jsonResponse(res, enriched);
        return;
      }

      const checkpointsMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/(.+)\/checkpoints$/);
      if (checkpointsMatch) {
        const agentId = checkpointsMatch[1]!;
        const sessionId = decodeURIComponent(checkpointsMatch[2]!);
        const checkpoints = await store.listCheckpoints(agentId, sessionId);
        jsonResponse(res, checkpoints);
        return;
      }

      const diffMatch = pathname.match(
        /^\/api\/sessions\/([^/]+)\/(.+)\/checkpoints\/([^/]+)\/diff$/,
      );
      if (diffMatch) {
        const agentId = diffMatch[1]!;
        const sessionId = decodeURIComponent(diffMatch[2]!);
        const checkpointId = diffMatch[3]!;
        const diff = await engine.getCheckpointDiff(agentId, sessionId, checkpointId);
        jsonResponse(res, { diff });
        return;
      }

      // POST /api/restore — restore workspace to a checkpoint
      if (req.method === "POST" && pathname === "/api/restore") {
        const body = await readBody(req);
        const { agentId, sessionId, checkpointId, scope } = JSON.parse(body);
        if (!agentId || !sessionId || !checkpointId) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Missing agentId, sessionId, or checkpointId" }));
          return;
        }
        const result = await engine.restoreCheckpoint({
          agentId,
          sessionId,
          checkpointId,
          workspaceDir: getWorkspaceDir(),
          scope: scope ?? "files",
        });
        jsonResponse(res, {
          ok: true,
          checkpointId: result.restoredCheckpoint.id,
          scope: result.scope,
          filesRestored: result.filesRestored,
          transcriptRestored: result.transcriptRestored,
        });
        return;
      }

      // POST /api/continue — restore checkpoint + start agent execution (SSE stream)
      if (req.method === "POST" && pathname === "/api/continue") {
        if (!runtime) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Agent runtime not available. Timeline was started outside of OpenClaw." }));
          return;
        }
        const body = await readBody(req);
        const { agentId, sessionId, checkpointId, message } = JSON.parse(body);
        if (!agentId || !sessionId || !checkpointId) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Missing agentId, sessionId, or checkpointId" }));
          return;
        }

        // SSE response
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
        });
        const sendSSE = (event: string, data: unknown) => {
          res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        };

        try {
          // Step 1: Restore
          sendSSE("status", { phase: "restoring", message: "Restoring workspace to checkpoint..." });
          const restoreResult = await engine.restoreCheckpoint({
            agentId, sessionId, checkpointId,
            workspaceDir: getWorkspaceDir(),
            scope: "all",
          });
          sendSSE("status", {
            phase: "restored",
            message: `Restored to ${restoreResult.restoredCheckpoint.id}`,
            filesRestored: restoreResult.filesRestored,
          });

          // Step 2: Start agent
          const sessionKey = `agent:${agentId}:checkpoint-continue:${sessionId}`;
          const prompt = message || "Continue the task from where it left off. The workspace has been restored to a previous checkpoint.";
          sendSSE("status", { phase: "starting", message: "Starting agent execution..." });
          const { runId } = await runtime.subagent.run({
            sessionKey,
            message: prompt,
            extraSystemPrompt: `You are resuming a task from checkpoint ${checkpointId}. The workspace files have been restored to that point. Continue where the previous agent left off.`,
          });
          sendSSE("status", { phase: "running", message: "Agent is running...", runId });

          // Step 3: Wait for completion
          const result = await runtime.subagent.waitForRun({ runId, timeoutMs: 300_000 });
          if (result.status === "ok") {
            // Fetch final messages
            const msgs = await runtime.subagent.getSessionMessages({ sessionKey, limit: 5 });
            const lastAssistant = (msgs.messages as Array<{ role: string; content?: string }>)
              .filter(m => m.role === "assistant")
              .pop();
            sendSSE("status", {
              phase: "done",
              message: "Agent completed successfully.",
              result: lastAssistant?.content ?? "(no output)",
            });
          } else {
            sendSSE("status", {
              phase: "error",
              message: result.status === "timeout" ? "Agent execution timed out (5min)." : `Agent failed: ${result.error ?? "unknown error"}`,
            });
          }
        } catch (e) {
          sendSSE("status", { phase: "error", message: `Error: ${String(e)}` });
        } finally {
          sendSSE("done", {});
          res.end();
        }
        return;
      }

      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(error) }));
    }
  });

  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, hostname, () => {
      const addr = server.address();
      const actualPort = typeof addr === "object" && addr ? addr.port : port;
      const serverUrl = `http://${hostname}:${actualPort}`;
      resolve({
        url: serverUrl,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

function jsonResponse(res: http.ServerResponse, data: unknown): void {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

