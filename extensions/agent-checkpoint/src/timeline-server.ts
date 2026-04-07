import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { CheckpointEngine } from "./engine.js";
import { getCachedWorkspaceDir } from "./hooks.js";
import type { CheckpointStore } from "./store.js";

export type TimelineServerParams = {
  engine: CheckpointEngine;
  store: CheckpointStore;
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
  const { engine, store, runtime } = params;
  const port = params.port ?? 0; // 0 = OS picks an available port
  const hostname = params.hostname ?? "127.0.0.1";

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

function getWorkspaceDir(): string {
  const cached = getCachedWorkspaceDir("main");
  if (cached) return cached;
  return path.join(os.homedir(), ".openclaw", "workspace");
}

// ── Inline HTML/CSS/JS SPA ─────────────────────────────────────────────────

const TIMELINE_HTML = /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agent Checkpoint Timeline</title>
<style>
  :root {
    --bg: #0d1117;
    --surface: #161b22;
    --border: #30363d;
    --text: #c9d1d9;
    --text-muted: #8b949e;
    --accent: #58a6ff;
    --green: #3fb950;
    --red: #f85149;
    --orange: #d29922;
    --timeline-line: #30363d;
    --node-size: 14px;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    background: var(--bg);
    color: var(--text);
    line-height: 1.5;
  }
  header {
    padding: 16px 24px;
    border-bottom: 1px solid var(--border);
    display: flex;
    align-items: center;
    gap: 16px;
  }
  header h1 {
    font-size: 18px;
    font-weight: 600;
    white-space: nowrap;
  }
  header select {
    background: var(--surface);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 6px 12px;
    font-size: 14px;
    cursor: pointer;
  }
  .container {
    display: flex;
    height: calc(100vh - 57px);
  }
  .timeline-panel {
    width: 420px;
    min-width: 320px;
    border-right: 1px solid var(--border);
    overflow-y: auto;
    padding: 16px 0;
  }
  .detail-panel {
    flex: 1;
    overflow-y: auto;
    padding: 24px;
  }
  .empty-state {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    color: var(--text-muted);
    font-size: 14px;
  }

  /* Timeline */
  .timeline {
    position: relative;
    padding-left: 40px;
  }
  .timeline::before {
    content: '';
    position: absolute;
    left: 23px;
    top: 0;
    bottom: 0;
    width: 2px;
    background: var(--timeline-line);
  }
  .timeline-item {
    position: relative;
    padding: 8px 16px 20px 24px;
    cursor: pointer;
    border-radius: 6px;
    margin: 0 8px;
    transition: background 0.15s;
  }
  .timeline-item:hover { background: var(--surface); }
  .timeline-item.active { background: var(--surface); }

  .timeline-node {
    position: absolute;
    left: -24px;
    top: 12px;
    width: var(--node-size);
    height: var(--node-size);
    border-radius: 50%;
    background: var(--border);
    border: 2px solid var(--bg);
    z-index: 1;
  }
  .timeline-item.active .timeline-node { background: var(--accent); }
  .timeline-item.error .timeline-node { background: var(--red); }
  .timeline-item.manual .timeline-node { background: var(--orange); }
  .timeline-item.session-start .timeline-node {
    background: var(--green);
    width: 18px;
    height: 18px;
    left: -26px;
    top: 10px;
  }

  .timeline-time {
    font-size: 12px;
    color: var(--text-muted);
    font-family: monospace;
  }
  .timeline-title {
    font-size: 14px;
    font-weight: 500;
    margin: 2px 0;
  }
  .timeline-meta {
    font-size: 12px;
    color: var(--text-muted);
    display: flex;
    gap: 12px;
    flex-wrap: wrap;
  }
  .timeline-meta span {
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }

  /* Badge */
  .badge {
    display: inline-block;
    padding: 1px 8px;
    border-radius: 12px;
    font-size: 11px;
    font-weight: 500;
  }
  .badge-tool { background: rgba(88,166,255,0.15); color: var(--accent); }
  .badge-manual { background: rgba(210,153,34,0.15); color: var(--orange); }
  .badge-session { background: rgba(63,185,80,0.15); color: var(--green); }
  .badge-error { background: rgba(248,81,73,0.15); color: var(--red); }
  .badge-child { background: rgba(188,143,243,0.15); color: var(--purple); }

  :root { --purple: #bc8ff3; }

  /* Session tree in selector */
  .session-option-child { padding-left: 20px; }

  /* Relation links */
  .relation-section { margin-bottom: 20px; }
  .relation-link {
    display: inline-block;
    padding: 4px 12px;
    margin: 2px 4px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 6px;
    font-size: 12px;
    font-family: monospace;
    color: var(--accent);
    cursor: pointer;
    transition: border-color 0.15s;
  }
  .relation-link:hover { border-color: var(--accent); }
  .relation-label {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--text-muted);
    margin-right: 8px;
  }

  /* Child checkpoint items in timeline */
  .timeline-item.child-session {
    opacity: 0.7;
    border-left: 2px solid var(--purple);
    margin-left: 12px;
  }
  .timeline-item.child-session .timeline-node {
    background: var(--purple);
    width: 10px;
    height: 10px;
    left: -21px;
    top: 14px;
  }
  .child-session-header {
    padding: 6px 16px 6px 36px;
    margin: 8px 8px 0;
    font-size: 12px;
    font-weight: 600;
    color: var(--purple);
    cursor: pointer;
  }
  .child-session-header:hover { text-decoration: underline; }

  /* Detail panel */
  .detail-header {
    margin-bottom: 24px;
  }
  .detail-header h2 {
    font-size: 16px;
    font-weight: 600;
    margin-bottom: 4px;
    font-family: monospace;
    word-break: break-all;
  }
  .detail-header .sub {
    font-size: 13px;
    color: var(--text-muted);
  }

  .detail-section {
    margin-bottom: 20px;
  }
  .detail-section h3 {
    font-size: 13px;
    font-weight: 600;
    text-transform: uppercase;
    color: var(--text-muted);
    margin-bottom: 8px;
    letter-spacing: 0.5px;
  }
  .detail-grid {
    display: grid;
    grid-template-columns: 140px 1fr;
    gap: 4px 12px;
    font-size: 13px;
  }
  .detail-grid dt {
    color: var(--text-muted);
    text-align: right;
  }
  .detail-grid dd {
    font-family: monospace;
    font-size: 12px;
  }

  .file-list {
    list-style: none;
    font-family: monospace;
    font-size: 12px;
    max-height: 300px;
    overflow-y: auto;
    background: var(--surface);
    border-radius: 6px;
    padding: 8px 12px;
    border: 1px solid var(--border);
  }
  .file-list li {
    padding: 2px 0;
    border-bottom: 1px solid var(--border);
  }
  .file-list li:last-child { border-bottom: none; }

  .diff-block {
    font-family: monospace;
    font-size: 12px;
    white-space: pre-wrap;
    background: var(--surface);
    border-radius: 6px;
    padding: 12px;
    border: 1px solid var(--border);
    max-height: 400px;
    overflow-y: auto;
    color: var(--text-muted);
  }

  .loading {
    color: var(--text-muted);
    font-style: italic;
    font-size: 13px;
  }

  /* Action buttons */
  .action-bar {
    display: flex;
    gap: 10px;
    margin-bottom: 20px;
  }
  .action-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 8px 16px;
    border-radius: 6px;
    border: 1px solid var(--border);
    background: var(--surface);
    color: var(--text);
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.15s;
  }
  .action-btn:hover { border-color: var(--accent); color: var(--accent); }
  .action-btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .action-btn.restore { border-color: var(--orange); color: var(--orange); }
  .action-btn.restore:hover { background: rgba(210,153,34,0.1); }
  .action-btn.continue { border-color: var(--green); color: var(--green); }
  .action-btn.continue:hover { background: rgba(63,185,80,0.1); }

  /* Toast notification */
  .toast {
    position: fixed;
    bottom: 24px;
    right: 24px;
    padding: 12px 20px;
    border-radius: 8px;
    font-size: 13px;
    font-weight: 500;
    z-index: 100;
    animation: toast-in 0.3s ease-out;
    max-width: 400px;
  }
  .toast.success { background: rgba(63,185,80,0.15); color: var(--green); border: 1px solid var(--green); }
  .toast.error { background: rgba(248,81,73,0.15); color: var(--red); border: 1px solid var(--red); }
  .toast.info { background: rgba(88,166,255,0.15); color: var(--accent); border: 1px solid var(--accent); }
  @keyframes toast-in { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: translateY(0); } }

  /* Confirm dialog */
  .modal-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.6);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 50;
  }
  .modal {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 24px;
    max-width: 440px;
    width: 90%;
  }
  .modal h3 { font-size: 16px; margin-bottom: 12px; }
  .modal p { font-size: 13px; color: var(--text-muted); margin-bottom: 16px; line-height: 1.6; }
  .modal-actions { display: flex; gap: 10px; justify-content: flex-end; }
  .modal-actions button {
    padding: 6px 16px;
    border-radius: 6px;
    border: 1px solid var(--border);
    background: var(--surface);
    color: var(--text);
    font-size: 13px;
    cursor: pointer;
  }
  .modal-actions button.confirm {
    background: var(--orange);
    color: #fff;
    border-color: var(--orange);
  }
  .modal-actions button.confirm:hover { opacity: 0.9; }
  .modal-actions button:hover { border-color: var(--accent); }

  /* Execution progress panel */
  .exec-panel {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    margin-bottom: 20px;
    overflow: hidden;
  }
  .exec-header {
    padding: 10px 16px;
    border-bottom: 1px solid var(--border);
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 13px;
    font-weight: 600;
  }
  .exec-header .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--text-muted);
  }
  .exec-header .dot.restoring { background: var(--orange); }
  .exec-header .dot.running { background: var(--green); animation: pulse 1s infinite; }
  .exec-header .dot.done { background: var(--green); }
  .exec-header .dot.error { background: var(--red); }
  @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }
  .exec-log {
    padding: 12px 16px;
    font-family: monospace;
    font-size: 12px;
    max-height: 300px;
    overflow-y: auto;
    line-height: 1.8;
  }
  .exec-log .log-entry {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    padding: 2px 0;
  }
  .exec-log .log-time {
    color: var(--text-muted);
    white-space: nowrap;
    flex-shrink: 0;
  }
  .exec-log .log-msg { color: var(--text); }
  .exec-log .log-msg.error { color: var(--red); }
  .exec-log .log-msg.success { color: var(--green); }
  .exec-result {
    padding: 12px 16px;
    border-top: 1px solid var(--border);
    font-size: 13px;
    white-space: pre-wrap;
    max-height: 200px;
    overflow-y: auto;
    color: var(--text);
  }
  .exec-input {
    padding: 10px 16px;
    border-top: 1px solid var(--border);
    display: flex;
    gap: 8px;
  }
  .exec-input input {
    flex: 1;
    background: var(--bg);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 6px 12px;
    font-size: 13px;
    outline: none;
  }
  .exec-input input:focus { border-color: var(--accent); }
  .exec-input input::placeholder { color: var(--text-muted); }
  .exec-input button {
    padding: 6px 16px;
    border-radius: 6px;
    border: 1px solid var(--green);
    background: var(--green);
    color: #fff;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
  }
  .exec-input button:hover { opacity: 0.9; }
  .exec-input button:disabled { opacity: 0.5; cursor: not-allowed; }

  @media (max-width: 768px) {
    .container { flex-direction: column; }
    .timeline-panel {
      width: 100%;
      height: 40vh;
      border-right: none;
      border-bottom: 1px solid var(--border);
    }
    .detail-panel { height: 60vh; }
  }
</style>
</head>
<body>
<header>
  <h1>Checkpoint Timeline</h1>
  <select id="session-select">
    <option value="">Loading sessions...</option>
  </select>
</header>
<div class="container">
  <div class="timeline-panel" id="timeline-panel">
    <div class="empty-state">Select a session to view checkpoints</div>
  </div>
  <div class="detail-panel" id="detail-panel">
    <div class="empty-state">Select a checkpoint to view details</div>
  </div>
</div>

<script>
const API = location.origin;
let currentCheckpoints = [];
let activeCheckpointId = null;
let allSessions = [];
let currentSession = null;

const sessionSelect = document.getElementById('session-select');
const timelinePanel = document.getElementById('timeline-panel');
const detailPanel = document.getElementById('detail-panel');

async function fetchJSON(path) {
  const res = await fetch(API + path);
  if (!res.ok) throw new Error(res.statusText);
  return res.json();
}

// ── Sessions ──

async function loadSessions() {
  try {
    allSessions = await fetchJSON('/api/sessions');
    renderSessionSelect();
    // Auto-select if only one root session
    const roots = allSessions.filter(s => !s.parentSession);
    if (roots.length === 1 && allSessions.length === 1) {
      sessionSelect.selectedIndex = 1;
      selectSession(roots[0].agentId, roots[0].sessionId);
    }
  } catch (e) {
    sessionSelect.innerHTML = '<option value="">Error loading sessions</option>';
  }
}

function renderSessionSelect() {
  sessionSelect.innerHTML = '';
  if (allSessions.length === 0) {
    sessionSelect.innerHTML = '<option value="">No sessions found</option>';
    return;
  }
  sessionSelect.innerHTML = '<option value="">Select a session...</option>';

  // Build tree: roots first, then children indented
  const roots = allSessions.filter(s => !s.parentSession);
  const childMap = {};
  for (const s of allSessions) {
    if (s.parentSession) {
      const pk = s.parentSession.agentId + '/' + s.parentSession.sessionId;
      if (!childMap[pk]) childMap[pk] = [];
      childMap[pk].push(s);
    }
  }

  function addSession(s, depth) {
    const opt = document.createElement('option');
    opt.value = s.agentId + '/' + s.sessionId;
    const prefix = depth > 0 ? '\\u2514\\u2500 ' : '';
    const indent = '\\u00A0\\u00A0'.repeat(depth);
    const label = s.sessionId.length > 16 ? s.sessionId.slice(0, 14) + '..' : s.sessionId;
    const count = s.checkpointCount > 0 ? ' (' + s.checkpointCount + ')' : '';
    opt.textContent = indent + prefix + s.agentId + ' / ' + label + count;
    sessionSelect.appendChild(opt);

    const key = s.agentId + '/' + s.sessionId;
    for (const child of (childMap[key] || [])) {
      addSession(child, depth + 1);
    }
  }

  for (const root of roots) addSession(root, 0);
  // Also show orphan children (parent not in list)
  for (const s of allSessions) {
    if (s.parentSession) {
      const pk = s.parentSession.agentId + '/' + s.parentSession.sessionId;
      const parentExists = allSessions.some(p => p.agentId + '/' + p.sessionId === pk);
      if (!parentExists) addSession(s, 0);
    }
  }
}

function selectSession(agentId, sessionId) {
  currentSession = allSessions.find(s => s.agentId === agentId && s.sessionId === sessionId) || null;
  sessionSelect.value = agentId + '/' + sessionId;
  loadCheckpoints(agentId, sessionId);
}

sessionSelect.addEventListener('change', () => {
  const val = sessionSelect.value;
  if (!val) return;
  const [agentId, ...rest] = val.split('/');
  const sessionId = rest.join('/');
  selectSession(agentId, sessionId);
});

// ── Checkpoints ──

async function loadCheckpoints(agentId, sessionId) {
  timelinePanel.innerHTML = '<div class="empty-state loading">Loading checkpoints...</div>';
  detailPanel.innerHTML = '<div class="empty-state">Select a checkpoint to view details</div>';
  activeCheckpointId = null;

  try {
    const checkpoints = await fetchJSON('/api/sessions/' + agentId + '/' + sessionId + '/checkpoints');

    // Also load child session checkpoints
    const children = currentSession?.childSessions || [];
    const childGroups = [];
    for (const child of children) {
      try {
        const childCps = await fetchJSON('/api/sessions/' + child.agentId + '/' + encodeURIComponent(child.sessionId) + '/checkpoints');
        if (childCps.length > 0) {
          childGroups.push({ ref: child, checkpoints: childCps });
        }
      } catch { /* skip */ }
    }

    currentCheckpoints = [...checkpoints, ...childGroups.flatMap(g => g.checkpoints)];

    if (checkpoints.length === 0 && childGroups.length === 0) {
      timelinePanel.innerHTML = '<div class="empty-state">No checkpoints in this session</div>';
      return;
    }

    renderTimeline(checkpoints, childGroups);
  } catch (e) {
    timelinePanel.innerHTML = '<div class="empty-state">Error: ' + e.message + '</div>';
  }
}

function renderTimeline(checkpoints, childGroups) {
  // Show newest first
  const sorted = [...checkpoints].reverse();

  let html = '<div class="timeline">';
  for (const cp of sorted) {
    html += renderTimelineItem(cp, false);
  }

  // Render child session groups
  for (const group of (childGroups || [])) {
    const label = group.ref.sessionId.length > 20
      ? group.ref.sessionId.slice(0, 18) + '..'
      : group.ref.sessionId;
    html += '<div class="child-session-header" data-agent="' + escapeHtml(group.ref.agentId)
      + '" data-session="' + escapeHtml(group.ref.sessionId)
      + '">&#9662; Child: ' + escapeHtml(group.ref.agentId) + ' / ' + escapeHtml(label)
      + ' (' + group.checkpoints.length + ')</div>';
    const childSorted = [...group.checkpoints].reverse();
    for (const cp of childSorted) {
      html += renderTimelineItem(cp, true);
    }
  }

  html += '</div>';
  timelinePanel.innerHTML = html;

  // Click handlers
  timelinePanel.querySelectorAll('.timeline-item').forEach(el => {
    el.addEventListener('click', () => selectCheckpoint(el.dataset.id));
  });
  timelinePanel.querySelectorAll('.child-session-header').forEach(el => {
    el.addEventListener('click', () => {
      selectSession(el.dataset.agent, el.dataset.session);
    });
  });
}

function renderTimelineItem(cp, isChild) {
  const isError = cp.toolResult?.success === false;
  const isManual = cp.trigger.type === 'manual';
  const isSession = cp.trigger.type === 'session_start';

  let cls = 'timeline-item';
  if (isChild) cls += ' child-session';
  if (isError) cls += ' error';
  else if (isManual) cls += ' manual';
  else if (isSession) cls += ' session-start';

  const time = formatTime(cp.createdAt);
  const title = getTriggerLabel(cp);
  const filesCount = cp.snapshot.filesChanged.length;
  const duration = cp.toolDurationMs != null ? formatDuration(cp.toolDurationMs) : null;

  let html = '<div class="' + cls + '" data-id="' + cp.id + '">';
  html += '<div class="timeline-node"></div>';
  html += '<div class="timeline-time">' + time + '</div>';
  html += '<div class="timeline-title">' + title + '</div>';
  html += '<div class="timeline-meta">';
  html += '<span>' + filesCount + ' file' + (filesCount !== 1 ? 's' : '') + '</span>';
  if (duration) html += '<span>' + duration + '</span>';
  if (isError) html += '<span class="badge badge-error">error</span>';
  if (isManual) html += '<span class="badge badge-manual">manual</span>';
  if (isSession) html += '<span class="badge badge-session">session start</span>';
  if (isChild) html += '<span class="badge badge-child">child</span>';
  if (cp.trigger.toolName && !isManual) html += '<span class="badge badge-tool">' + escapeHtml(cp.trigger.toolName) + '</span>';
  html += '</div></div>';
  return html;
}

function selectCheckpoint(id) {
  activeCheckpointId = id;
  // Update active state
  timelinePanel.querySelectorAll('.timeline-item').forEach(el => {
    el.classList.toggle('active', el.dataset.id === id);
  });
  renderDetail(id);
}

// ── Detail ──

async function renderDetail(checkpointId) {
  const cp = currentCheckpoints.find(c => c.id === checkpointId);
  if (!cp) return;

  // Find which session this checkpoint belongs to
  const cpSession = allSessions.find(s => s.agentId === cp.agentId && s.sessionId === cp.sessionId);

  let html = '<div class="detail-header">';
  html += '<h2>' + escapeHtml(cp.id) + '</h2>';
  html += '<div class="sub">' + cp.createdAt + '</div>';
  html += '</div>';

  // Action buttons
  html += '<div class="action-bar">';
  html += '<button class="action-btn restore" data-restore-id="' + escapeAttr(cp.id) + '" data-scope="files">';
  html += '&#x21A9; Restore Files</button>';
  html += '<button class="action-btn continue" data-continue-id="' + escapeAttr(cp.id) + '">';
  html += '&#x25B6; Restore &amp; Continue</button>';
  html += '</div>';

  // Session relations
  if (cpSession) {
    const hasParent = cpSession.parentSession;
    const hasChildren = cpSession.childSessions && cpSession.childSessions.length > 0;
    if (hasParent || hasChildren) {
      html += '<div class="relation-section">';
      if (hasParent) {
        const p = cpSession.parentSession;
        const pLabel = p.sessionId.length > 16 ? p.sessionId.slice(0, 14) + '..' : p.sessionId;
        html += '<span class="relation-label">Parent:</span>';
        html += '<span class="relation-link" data-nav-agent="' + escapeAttr(p.agentId) + '" data-nav-session="' + escapeAttr(p.sessionId) + '">';
        html += escapeHtml(p.agentId) + ' / ' + escapeHtml(pLabel) + '</span> ';
      }
      if (hasChildren) {
        html += '<span class="relation-label">Children:</span>';
        for (const c of cpSession.childSessions) {
          const cLabel = c.sessionId.length > 16 ? c.sessionId.slice(0, 14) + '..' : c.sessionId;
          html += '<span class="relation-link" data-nav-agent="' + escapeAttr(c.agentId) + '" data-nav-session="' + escapeAttr(c.sessionId) + '">';
          html += escapeHtml(c.agentId) + ' / ' + escapeHtml(cLabel) + '</span> ';
        }
      }
      html += '</div>';
    }
  }

  // Info grid
  html += '<div class="detail-section"><h3>Details</h3>';
  html += '<dl class="detail-grid">';
  html += dt('Trigger') + dd(cp.trigger.type);
  if (cp.trigger.toolName) html += dt('Tool') + dd(cp.trigger.toolName);
  if (cp.trigger.toolCallId) html += dt('Tool Call ID') + dd(cp.trigger.toolCallId);
  html += dt('Agent / Session') + dd(cp.agentId + ' / ' + cp.sessionId);
  html += dt('Parent CP') + dd(cp.parentId || '(none)');
  html += dt('Backend') + dd(cp.snapshot.backendType);
  html += dt('Snapshot Ref') + dd(cp.snapshot.snapshotRef);
  if (cp.toolDurationMs != null) html += dt('Duration') + dd(formatDuration(cp.toolDurationMs));
  if (cp.toolResult) {
    html += dt('Tool Result') + dd(cp.toolResult.success ? 'success' : 'failed');
    if (cp.toolResult.errorMessage) html += dt('Error') + dd(cp.toolResult.errorMessage);
  }
  html += dt('Transcript Msgs') + dd(String(cp.transcript.messageCount));
  html += dt('Transcript Bytes') + dd(formatBytes(cp.transcript.byteOffset));
  if (cp.snapshot.changeSummary) html += dt('Summary') + dd(cp.snapshot.changeSummary);
  html += '</dl></div>';

  // Files changed
  if (cp.snapshot.filesChanged.length > 0) {
    html += '<div class="detail-section"><h3>Files Changed (' + cp.snapshot.filesChanged.length + ')</h3>';
    html += '<ul class="file-list">';
    for (const f of cp.snapshot.filesChanged) {
      html += '<li>' + escapeHtml(f) + '</li>';
    }
    html += '</ul></div>';
  }

  // Diff (lazy loaded)
  html += '<div class="detail-section"><h3>Diff</h3>';
  html += '<div class="diff-block" id="diff-block">Loading diff...</div>';
  html += '</div>';

  detailPanel.innerHTML = html;

  // Bind relation link clicks
  detailPanel.querySelectorAll('.relation-link[data-nav-agent]').forEach(el => {
    el.addEventListener('click', () => {
      selectSession(el.dataset.navAgent, el.dataset.navSession);
    });
  });

  // Bind action buttons
  const restoreBtn = detailPanel.querySelector('[data-restore-id]');
  if (restoreBtn) {
    restoreBtn.addEventListener('click', () => {
      restoreToCheckpoint(restoreBtn.dataset.restoreId, restoreBtn.dataset.scope);
    });
  }
  const continueBtn = detailPanel.querySelector('[data-continue-id]');
  if (continueBtn) {
    continueBtn.addEventListener('click', () => {
      restoreAndContinue(continueBtn.dataset.continueId);
    });
  }

  // Load diff async
  try {
    const data = await fetchJSON(
      '/api/sessions/' + cp.agentId + '/' + cp.sessionId + '/checkpoints/' + cp.id + '/diff'
    );
    const diffEl = document.getElementById('diff-block');
    if (diffEl && activeCheckpointId === cp.id) {
      diffEl.textContent = data.diff || '(no diff available)';
    }
  } catch (e) {
    const diffEl = document.getElementById('diff-block');
    if (diffEl) diffEl.textContent = 'Error loading diff: ' + e.message;
  }
}

// ── Helpers ──

function getTriggerLabel(cp) {
  if (cp.trigger.type === 'session_start') return 'Session Start';
  if (cp.trigger.type === 'manual') return cp.trigger.toolName || 'Manual Checkpoint';
  if (cp.trigger.toolName) return 'After: ' + cp.trigger.toolName;
  return cp.trigger.type;
}

function formatTime(iso) {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    + ' ' + d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function formatDuration(ms) {
  if (ms < 1000) return ms + 'ms';
  return (ms / 1000).toFixed(1) + 's';
}

function formatBytes(b) {
  if (b === 0) return '0 B';
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
  return (b / (1024 * 1024)).toFixed(1) + ' MB';
}

function escapeHtml(s) {
  const el = document.createElement('span');
  el.textContent = s;
  return el.innerHTML;
}

function escapeAttr(s) {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function dt(label) { return '<dt>' + label + '</dt>'; }
function dd(value) { return '<dd>' + escapeHtml(String(value)) + '</dd>'; }

// ── Actions (Restore / Continue) ──

function showToast(msg, type) {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

function showConfirm(title, message, onConfirm) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML =
    '<div class="modal">' +
    '<h3>' + escapeHtml(title) + '</h3>' +
    '<p>' + message + '</p>' +
    '<div class="modal-actions">' +
    '<button class="cancel">Cancel</button>' +
    '<button class="confirm">Confirm</button>' +
    '</div></div>';
  document.body.appendChild(overlay);
  overlay.querySelector('.cancel').addEventListener('click', () => overlay.remove());
  overlay.querySelector('.confirm').addEventListener('click', () => {
    overlay.remove();
    onConfirm();
  });
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
}

async function restoreToCheckpoint(checkpointId, scope) {
  const cp = currentCheckpoints.find(c => c.id === checkpointId);
  if (!cp) return;

  showConfirm(
    'Restore Checkpoint',
    'Restore workspace to <strong>' + escapeHtml(checkpointId) + '</strong>?<br>' +
    'Scope: <strong>' + escapeHtml(scope) + '</strong><br><br>' +
    'This will overwrite current workspace files with the snapshot from this checkpoint.' +
    (scope === 'all' ? ' Transcript will also be truncated.' : ''),
    async () => {
      const btns = detailPanel.querySelectorAll('.action-btn');
      btns.forEach(b => b.disabled = true);
      try {
        const res = await fetch(API + '/api/restore', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            agentId: cp.agentId,
            sessionId: cp.sessionId,
            checkpointId: cp.id,
            scope,
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Restore failed');
        showToast('Restored to ' + data.checkpointId + ' (scope: ' + data.scope + ')', 'success');
        // Reload checkpoints since later ones were pruned
        if (currentSession) {
          loadCheckpoints(currentSession.agentId, currentSession.sessionId);
        }
      } catch (e) {
        showToast('Restore failed: ' + e.message, 'error');
      } finally {
        btns.forEach(b => b.disabled = false);
      }
    }
  );
}

let activeExecAbort = null;

function restoreAndContinue(checkpointId) {
  const cp = currentCheckpoints.find(c => c.id === checkpointId);
  if (!cp) return;
  startExecution(cp, '');
}

function startExecution(cp, message) {
  // Insert execution panel into detail panel (after action bar)
  const actionBar = detailPanel.querySelector('.action-bar');
  if (!actionBar) return;

  // Disable buttons
  detailPanel.querySelectorAll('.action-btn').forEach(b => b.disabled = true);

  // Remove any existing exec panel
  const old = detailPanel.querySelector('.exec-panel');
  if (old) old.remove();

  const panel = document.createElement('div');
  panel.className = 'exec-panel';
  panel.innerHTML =
    '<div class="exec-header">' +
    '<span class="dot restoring"></span>' +
    '<span class="exec-status">Connecting...</span>' +
    '</div>' +
    '<div class="exec-log"></div>';
  actionBar.after(panel);

  const dot = panel.querySelector('.dot');
  const statusEl = panel.querySelector('.exec-status');
  const logEl = panel.querySelector('.exec-log');

  function addLog(msg, cls) {
    const now = new Date();
    const time = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const entry = document.createElement('div');
    entry.className = 'log-entry';
    entry.innerHTML = '<span class="log-time">' + time + '</span><span class="log-msg' + (cls ? ' ' + cls : '') + '">' + escapeHtml(msg) + '</span>';
    logEl.appendChild(entry);
    logEl.scrollTop = logEl.scrollHeight;
  }

  // Start SSE connection via POST (using fetch + ReadableStream since EventSource only does GET)
  const controller = new AbortController();
  activeExecAbort = controller;

  fetch(API + '/api/continue', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      agentId: cp.agentId,
      sessionId: cp.sessionId,
      checkpointId: cp.id,
      message: message,
    }),
    signal: controller.signal,
  }).then(async (response) => {
    if (!response.ok) {
      const err = await response.json().catch(() => ({ error: 'Request failed' }));
      addLog(err.error || 'Request failed', 'error');
      dot.className = 'dot error';
      statusEl.textContent = 'Failed';
      detailPanel.querySelectorAll('.action-btn').forEach(b => b.disabled = false);
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Parse SSE events from buffer
      const lines = buffer.split('\\n');
      buffer = lines.pop() || '';

      let eventType = null;
      for (const line of lines) {
        if (line.startsWith('event: ')) {
          eventType = line.slice(7).trim();
        } else if (line.startsWith('data: ') && eventType) {
          try {
            const data = JSON.parse(line.slice(6));
            handleSSE(eventType, data, dot, statusEl, addLog, panel, cp);
          } catch {}
          eventType = null;
        }
      }
    }
  }).catch((e) => {
    if (e.name !== 'AbortError') {
      addLog('Connection error: ' + e.message, 'error');
      dot.className = 'dot error';
      statusEl.textContent = 'Connection failed';
    }
    detailPanel.querySelectorAll('.action-btn').forEach(b => b.disabled = false);
  });
}

function handleSSE(event, data, dot, statusEl, addLog, panel, cp) {
  if (event === 'status') {
    const phase = data.phase;
    addLog(data.message, phase === 'error' ? 'error' : phase === 'done' ? 'success' : '');

    if (phase === 'restoring') {
      dot.className = 'dot restoring';
      statusEl.textContent = 'Restoring...';
    } else if (phase === 'restored') {
      dot.className = 'dot restoring';
      statusEl.textContent = 'Restored';
    } else if (phase === 'starting' || phase === 'running') {
      dot.className = 'dot running';
      statusEl.textContent = 'Agent running...';
    } else if (phase === 'done') {
      dot.className = 'dot done';
      statusEl.textContent = 'Completed';
      // Show result
      if (data.result) {
        const resultEl = document.createElement('div');
        resultEl.className = 'exec-result';
        resultEl.textContent = typeof data.result === 'string' ? data.result : JSON.stringify(data.result, null, 2);
        panel.appendChild(resultEl);
      }
      detailPanel.querySelectorAll('.action-btn').forEach(b => b.disabled = false);
      // Reload timeline
      if (currentSession) {
        loadCheckpoints(currentSession.agentId, currentSession.sessionId);
      }
    } else if (phase === 'error') {
      dot.className = 'dot error';
      statusEl.textContent = 'Failed';
      detailPanel.querySelectorAll('.action-btn').forEach(b => b.disabled = false);
    }
  } else if (event === 'done') {
    activeExecAbort = null;
    if (dot.className === 'dot running') {
      dot.className = 'dot done';
      statusEl.textContent = 'Completed';
      detailPanel.querySelectorAll('.action-btn').forEach(b => b.disabled = false);
    }
  }
}

// ── Init ──

loadSessions();
</script>
</body>
</html>`;
