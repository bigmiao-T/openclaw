import { createRequire } from "node:module";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { CheckpointEngine } from "./engine.js";
import type { CheckpointHookState } from "./hooks.js";
import { buildContinuationContext } from "./restore-context.js";
import type { CheckpointStore } from "./store.js";
import type { CheckpointMeta } from "./types.js";
import { TIMELINE_HTML } from "./timeline-html.js";

const require = createRequire(import.meta.url);
const PLUGIN_VERSION: string = (require("../package.json") as { version: string }).version;

/** Unified timeline event for the timeline viewer API. */
export type TimelineEvent = {
  type: "user_message" | "assistant_reply" | "tool_call" | "tool_result" | "checkpoint" | "session_start" | "compaction";
  timestamp: string;
  /** Epoch ms for reliable numeric sorting (avoids string format inconsistencies). */
  epochMs: number;
  /** Sequence index from the source (JSONL line number or checkpoint order) for stable sort within same epoch. */
  seq: number;
  content: string;
  /** Full content for detail view (not truncated). Only set when different from content. */
  fullContent?: string;
  toolName?: string;
  isError?: boolean;
  checkpointId?: string;
  checkpoint?: CheckpointMeta;
};

/** Parse any timestamp (ISO string or epoch ms number) to epoch ms. */
export function toEpochMs(ts: unknown): number {
  if (typeof ts === "number") return ts;
  if (typeof ts === "string") {
    const ms = Date.parse(ts);
    return Number.isFinite(ms) ? ms : 0;
  }
  return 0;
}

export type TimelineServerParams = {
  engine: CheckpointEngine;
  store: CheckpointStore;
  hookState: CheckpointHookState;
  port?: number;
  hostname?: string;
  /** Resolve the actual transcript file path from session store. */
  resolveTranscriptPath?: (agentId: string, sessionId: string) => string;
  /** Called after transcript restore to update session store with new file path. */
  onTranscriptRestored?: (agentId: string, sessionId: string, newTranscriptPath: string) => Promise<void>;
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

      if (pathname === "/api/version") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ version: PLUGIN_VERSION }));
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
          readSessionTranscript(agentId, sessionId, params.resolveTranscriptPath),
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
        const sessionTranscriptPath = params.resolveTranscriptPath
          ? params.resolveTranscriptPath(agentId, sessionId)
          : defaultTranscriptPath(agentId, sessionId);
        const onTranscriptRestoredCb = params.onTranscriptRestored;
        const result = await engine.restoreCheckpoint({
          agentId,
          sessionId,
          checkpointId,
          workspaceDir: getWorkspaceDir(),
          scope: scope ?? "all",
          sessionTranscriptPath,
          onTranscriptRestored: onTranscriptRestoredCb
            ? (newPath) => onTranscriptRestoredCb(agentId, sessionId, newPath)
            : undefined,
        });
        const continuation = buildContinuationContext({
          checkpoint: result.restoredCheckpoint,
          diff: result.diff,
          scope: result.scope,
          filesRestored: result.filesRestored,
          transcriptRestored: result.transcriptRestored,
        });
        jsonResponse(res, {
          ok: true,
          checkpointId: result.restoredCheckpoint.id,
          scope: result.scope,
          filesRestored: result.filesRestored,
          transcriptRestored: result.transcriptRestored,
          diff: result.diff,
          summary: continuation.summary,
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

/** Returns { content, fullContent } — fullContent is set only when truncated. */
function contentPair(s: string): { content: string; fullContent?: string } {
  if (s.length > MAX_CONTENT_PREVIEW) {
    return { content: truncate(s), fullContent: s };
  }
  return { content: s };
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
function extractToolCalls(content: unknown): Array<{ name: string; id?: string; input?: string }> {
  if (!Array.isArray(content)) return [];
  return content
    .filter((b: any) => (b?.type === "toolCall" || b?.type === "toolUse") && typeof b.name === "string")
    .map((b: any) => {
      const input = b.input ?? b.arguments;
      return {
        name: b.name,
        id: b.id,
        input: input ? JSON.stringify(input, null, 2) : undefined,
      };
    });
}

/** Default transcript path when no session store resolver is available. */
function defaultTranscriptPath(agentId: string, sessionId: string): string {
  return path.join(os.homedir(), ".openclaw", "agents", agentId, "sessions", `${sessionId}.jsonl`);
}

/**
 * Read a session JSONL transcript and extract timeline events.
 * Uses resolveTranscriptPath to honor session store's sessionFile pointer.
 */
async function readSessionTranscript(
  agentId: string,
  sessionId: string,
  resolveTranscriptPath?: (agentId: string, sessionId: string) => string,
): Promise<TimelineEvent[]> {
  const transcriptPath = resolveTranscriptPath
    ? resolveTranscriptPath(agentId, sessionId)
    : defaultTranscriptPath(agentId, sessionId);

  let raw: string;
  try {
    raw = await fs.readFile(transcriptPath, "utf8");
  } catch {
    return []; // Transcript not found — session may use a different path or not exist
  }

  const events: TimelineEvent[] = [];
  let seq = 0;
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    if (entry.type === "session" && entry.timestamp) {
      events.push({ type: "session_start", seq: seq++, epochMs: toEpochMs(entry.timestamp), timestamp: entry.timestamp, content: "Session started" });
      continue;
    }

    if (entry.type === "compaction" && entry.timestamp) {
      events.push({
        type: "compaction",
        seq: seq++,
        epochMs: toEpochMs(entry.timestamp),
        timestamp: entry.timestamp,
        content: entry.summary ? truncate(entry.summary) : "Context compacted",
      });
      continue;
    }

    if (entry.type !== "message" || !entry.message) continue;

    const msg = entry.message;
    // Prefer entry-level timestamp (ISO), fall back to msg.timestamp (epoch ms)
    const ts = entry.timestamp ?? (msg.timestamp ? new Date(msg.timestamp).toISOString() : "");
    if (!ts) continue;
    const epochMs = toEpochMs(entry.timestamp) || toEpochMs(msg.timestamp);

    if (msg.role === "user") {
      const text = extractText(msg.content);
      if (text) {
        events.push({ type: "user_message", seq: seq++, epochMs, timestamp: ts, ...contentPair(text) });
      }
    } else if (msg.role === "assistant") {
      const text = extractText(msg.content);
      const tools = extractToolCalls(msg.content);

      if (text) {
        events.push({ type: "assistant_reply", seq: seq++, epochMs, timestamp: ts, ...contentPair(text) });
      }
      for (const tool of tools) {
        const toolContent = tool.input ? tool.name + "\n" + tool.input : tool.name;
        events.push({ type: "tool_call", seq: seq++, epochMs, timestamp: ts, ...contentPair(toolContent), toolName: tool.name });
      }
    } else if (msg.role === "toolResult") {
      const text = typeof msg.content === "string" ? msg.content : extractText(msg.content);
      events.push({
        type: "tool_result",
        seq: seq++,
        epochMs,
        timestamp: ts,
        ...contentPair(text || "(no output)"),
        toolName: msg.toolName,
        isError: msg.isError === true,
      });
    }
  }
  return events;
}

/**
 * Merge session transcript events with checkpoint data into a unified timeline.
 *
 * Sorting: primary by epochMs (numeric, avoids ISO string format issues),
 * tiebreaker by seq (source order — JSONL line number for transcript events,
 * fractional insertion point for checkpoints).
 */
export function buildTimeline(transcriptEvents: TimelineEvent[], checkpoints: CheckpointMeta[]): TimelineEvent[] {
  // after_tool_call checkpoints are created after tool execution, so they
  // naturally have epochMs > tool_result's epochMs. No epoch snapping needed —
  // the checkpoint appears after the tool_result in chronological order.

  const cpEvents: TimelineEvent[] = checkpoints.map((cp, i) => {
    const epochMs = toEpochMs(cp.createdAt);

    return {
      type: "checkpoint" as const,
      seq: findInsertionSeq(transcriptEvents, epochMs, i),
      epochMs,
      timestamp: cp.createdAt,
      content: cp.trigger.toolName
        ? `Checkpoint after ${cp.trigger.toolName}`
        : cp.trigger.type === "session_start"
          ? "Session start checkpoint"
          : "Manual checkpoint",
      toolName: cp.trigger.toolName,
      checkpointId: cp.id,
      checkpoint: cp,
    };
  });

  const all = [...transcriptEvents, ...cpEvents];
  all.sort((a, b) => {
    const cmp = a.epochMs - b.epochMs;
    if (cmp !== 0) return cmp;
    // Same ms: enforce logical order (tool_call → tool_result → checkpoint)
    const wCmp = eventTypeWeight(a.type) - eventTypeWeight(b.type);
    if (wCmp !== 0) return wCmp;
    // Same type at same ms: preserve source order
    return a.seq - b.seq;
  });
  return all;
}

/** Logical display order within the same millisecond. */
function eventTypeWeight(type: TimelineEvent["type"]): number {
  switch (type) {
    case "session_start": return 0;
    case "user_message": return 1;
    case "assistant_reply": return 2;
    case "tool_call": return 3;
    case "tool_result": return 4;
    case "checkpoint": return 5;
    case "compaction": return 6;
  }
}

/**
 * Find a seq value for a checkpoint that places it just after the last
 * transcript event at or before its epoch, so it appears between the
 * preceding event and the tool call it guards.
 */
function findInsertionSeq(transcriptEvents: TimelineEvent[], cpEpochMs: number, cpIndex: number): number {
  let lastBefore = -1;
  for (const ev of transcriptEvents) {
    if (ev.epochMs <= cpEpochMs && ev.seq > lastBefore) {
      lastBefore = ev.seq;
    }
  }
  return lastBefore + 0.5 + cpIndex * 0.001;
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

