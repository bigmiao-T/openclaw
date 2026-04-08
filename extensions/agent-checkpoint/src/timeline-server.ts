import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { CheckpointEngine } from "./engine.js";
import type { CheckpointHookState } from "./hooks.js";
import type { CheckpointStore } from "./store.js";
import type { CheckpointMeta } from "./types.js";
import { TIMELINE_HTML } from "./timeline-html.js";

/** Unified timeline event for the timeline viewer API. */
type TimelineEvent = {
  type: "user_message" | "assistant_reply" | "tool_call" | "tool_result" | "checkpoint" | "session_start" | "compaction";
  timestamp: string;
  content: string;
  toolName?: string;
  isError?: boolean;
  checkpointId?: string;
  checkpoint?: CheckpointMeta;
};

export type TimelineServerParams = {
  engine: CheckpointEngine;
  store: CheckpointStore;
  hookState: CheckpointHookState;
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
  const { engine, store, hookState } = params;
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

      const timelineMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/(.+)\/timeline$/);
      if (timelineMatch) {
        const agentId = timelineMatch[1]!;
        const sessionId = decodeURIComponent(timelineMatch[2]!);
        const [transcriptEvents, checkpoints] = await Promise.all([
          readSessionTranscript(agentId, sessionId),
          store.listCheckpoints(agentId, sessionId),
        ]);
        const timeline = buildTimeline(transcriptEvents, checkpoints);
        jsonResponse(res, { events: timeline });
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
        const cp = result.restoredCheckpoint;
        const triggerInfo = cp.trigger.type === "before_tool_call" && cp.trigger.toolName
          ? `Saved before ${cp.trigger.toolName} — tool changes undone.`
          : undefined;
        jsonResponse(res, {
          ok: true,
          checkpointId: cp.id,
          scope: result.scope,
          filesRestored: result.filesRestored,
          transcriptRestored: result.transcriptRestored,
          triggerInfo,
          hint: "Conversation history is intact. Tell the agent what to do next.",
        });
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

const MAX_CONTENT_PREVIEW = 200;

function truncate(s: string, max = MAX_CONTENT_PREVIEW): string {
  return s.length > max ? s.slice(0, max) + "..." : s;
}

/** Extract text from a JSONL message content block array. */
function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b: any) => b?.type === "text" && typeof b.text === "string")
    .map((b: any) => b.text)
    .join("\n");
}

/** Extract tool call names from a JSONL message content block array. */
function extractToolCalls(content: unknown): Array<{ name: string; id?: string }> {
  if (!Array.isArray(content)) return [];
  return content
    .filter((b: any) => (b?.type === "toolCall" || b?.type === "toolUse") && typeof b.name === "string")
    .map((b: any) => ({ name: b.name, id: b.id }));
}

/**
 * Read a session JSONL transcript and extract timeline events.
 * Path: ~/.openclaw/agents/{agentId}/sessions/{sessionId}.jsonl
 */
async function readSessionTranscript(agentId: string, sessionId: string): Promise<TimelineEvent[]> {
  const sessionsDir = path.join(os.homedir(), ".openclaw", "agents", agentId, "sessions");
  const transcriptPath = path.join(sessionsDir, `${sessionId}.jsonl`);

  let raw: string;
  try {
    raw = await fs.readFile(transcriptPath, "utf8");
  } catch {
    return []; // Transcript not found — session may use a different path or not exist
  }

  const events: TimelineEvent[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    if (entry.type === "session" && entry.timestamp) {
      events.push({ type: "session_start", timestamp: entry.timestamp, content: "Session started" });
      continue;
    }

    if (entry.type === "compaction" && entry.timestamp) {
      events.push({
        type: "compaction",
        timestamp: entry.timestamp,
        content: entry.summary ? truncate(entry.summary) : "Context compacted",
      });
      continue;
    }

    if (entry.type !== "message" || !entry.message) continue;

    const msg = entry.message;
    const ts = entry.timestamp ?? (msg.timestamp ? new Date(msg.timestamp).toISOString() : "");
    if (!ts) continue;

    if (msg.role === "user") {
      const text = extractText(msg.content);
      if (text) {
        events.push({ type: "user_message", timestamp: ts, content: truncate(text) });
      }
    } else if (msg.role === "assistant") {
      const text = extractText(msg.content);
      const tools = extractToolCalls(msg.content);

      if (text) {
        events.push({ type: "assistant_reply", timestamp: ts, content: truncate(text) });
      }
      for (const tool of tools) {
        events.push({ type: "tool_call", timestamp: ts, content: tool.name, toolName: tool.name });
      }
    } else if (msg.role === "toolResult") {
      const text = typeof msg.content === "string" ? msg.content : extractText(msg.content);
      events.push({
        type: "tool_result",
        timestamp: ts,
        content: truncate(text || "(no output)"),
        toolName: msg.toolName,
        isError: msg.isError === true,
      });
    }
  }
  return events;
}

/** Merge session transcript events with checkpoint data into a unified timeline. */
function buildTimeline(transcriptEvents: TimelineEvent[], checkpoints: CheckpointMeta[]): TimelineEvent[] {
  const cpEvents: TimelineEvent[] = checkpoints.map((cp) => ({
    type: "checkpoint" as const,
    timestamp: cp.createdAt,
    content: cp.trigger.toolName
      ? `Checkpoint before ${cp.trigger.toolName}`
      : cp.trigger.type === "session_start"
        ? "Session start checkpoint"
        : "Manual checkpoint",
    toolName: cp.trigger.toolName,
    checkpointId: cp.id,
    checkpoint: cp,
  }));

  const all = [...transcriptEvents, ...cpEvents];
  all.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return all;
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

