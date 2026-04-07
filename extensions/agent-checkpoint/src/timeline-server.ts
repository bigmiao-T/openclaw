import http from "node:http";
import type { CheckpointEngine } from "./engine.js";
import type { CheckpointStore } from "./store.js";

export type TimelineServerParams = {
  engine: CheckpointEngine;
  store: CheckpointStore;
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
  const { engine, store } = params;
  const port = params.port ?? 0; // 0 = OS picks an available port
  const hostname = params.hostname ?? "127.0.0.1";

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${hostname}`);
    const pathname = url.pathname;

    // CORS for local dev
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
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
        jsonResponse(res, sessions);
        return;
      }

      const checkpointsMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/([^/]+)\/checkpoints$/);
      if (checkpointsMatch) {
        const [, agentId, sessionId] = checkpointsMatch;
        const checkpoints = await store.listCheckpoints(agentId!, sessionId!);
        jsonResponse(res, checkpoints);
        return;
      }

      const diffMatch = pathname.match(
        /^\/api\/sessions\/([^/]+)\/([^/]+)\/checkpoints\/([^/]+)\/diff$/,
      );
      if (diffMatch) {
        const [, agentId, sessionId, checkpointId] = diffMatch;
        const diff = await engine.getCheckpointDiff(agentId!, sessionId!, checkpointId!);
        jsonResponse(res, { diff });
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
    const sessions = await fetchJSON('/api/sessions');
    sessionSelect.innerHTML = '';
    if (sessions.length === 0) {
      sessionSelect.innerHTML = '<option value="">No sessions found</option>';
      return;
    }
    sessionSelect.innerHTML = '<option value="">Select a session...</option>';
    for (const s of sessions) {
      const opt = document.createElement('option');
      opt.value = s.agentId + '/' + s.sessionId;
      opt.textContent = s.agentId + ' / ' + s.sessionId.slice(0, 12) + '...';
      sessionSelect.appendChild(opt);
    }
    // Auto-select if only one session
    if (sessions.length === 1) {
      sessionSelect.selectedIndex = 1;
      loadCheckpoints(sessions[0].agentId, sessions[0].sessionId);
    }
  } catch (e) {
    sessionSelect.innerHTML = '<option value="">Error loading sessions</option>';
  }
}

sessionSelect.addEventListener('change', () => {
  const val = sessionSelect.value;
  if (!val) return;
  const [agentId, sessionId] = val.split('/');
  loadCheckpoints(agentId, sessionId);
});

// ── Checkpoints ──

async function loadCheckpoints(agentId, sessionId) {
  timelinePanel.innerHTML = '<div class="empty-state loading">Loading checkpoints...</div>';
  detailPanel.innerHTML = '<div class="empty-state">Select a checkpoint to view details</div>';
  activeCheckpointId = null;

  try {
    const checkpoints = await fetchJSON('/api/sessions/' + agentId + '/' + sessionId + '/checkpoints');
    currentCheckpoints = checkpoints;

    if (checkpoints.length === 0) {
      timelinePanel.innerHTML = '<div class="empty-state">No checkpoints in this session</div>';
      return;
    }

    renderTimeline(checkpoints);
  } catch (e) {
    timelinePanel.innerHTML = '<div class="empty-state">Error: ' + e.message + '</div>';
  }
}

function renderTimeline(checkpoints) {
  // Show newest first
  const sorted = [...checkpoints].reverse();

  let html = '<div class="timeline">';
  for (const cp of sorted) {
    const isError = cp.toolResult?.success === false;
    const isManual = cp.trigger.type === 'manual';
    const isSession = cp.trigger.type === 'session_start';

    let cls = 'timeline-item';
    if (isError) cls += ' error';
    else if (isManual) cls += ' manual';
    else if (isSession) cls += ' session-start';

    const time = formatTime(cp.createdAt);
    const title = getTriggerLabel(cp);
    const filesCount = cp.snapshot.filesChanged.length;
    const duration = cp.toolDurationMs != null ? formatDuration(cp.toolDurationMs) : null;

    html += '<div class="' + cls + '" data-id="' + cp.id + '">';
    html += '<div class="timeline-node"></div>';
    html += '<div class="timeline-time">' + time + '</div>';
    html += '<div class="timeline-title">' + title + '</div>';
    html += '<div class="timeline-meta">';
    html += '<span>' + filesCount + ' file' + (filesCount !== 1 ? 's' : '') + '</span>';
    if (duration) html += '<span>' + duration + '</span>';
    if (isError) html += '<span class="badge badge-error">error</span>';
    if (isManual) html += '<span class="badge badge-manual">manual</span>';
    if (isSession) html += '<span class="badge badge-session">session start</span>';
    if (cp.trigger.toolName && !isManual) html += '<span class="badge badge-tool">' + escapeHtml(cp.trigger.toolName) + '</span>';
    html += '</div></div>';
  }
  html += '</div>';
  timelinePanel.innerHTML = html;

  // Click handlers
  timelinePanel.querySelectorAll('.timeline-item').forEach(el => {
    el.addEventListener('click', () => {
      const id = el.dataset.id;
      selectCheckpoint(id);
    });
  });
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

  let html = '<div class="detail-header">';
  html += '<h2>' + escapeHtml(cp.id) + '</h2>';
  html += '<div class="sub">' + cp.createdAt + '</div>';
  html += '</div>';

  // Info grid
  html += '<div class="detail-section"><h3>Details</h3>';
  html += '<dl class="detail-grid">';
  html += dt('Trigger') + dd(cp.trigger.type);
  if (cp.trigger.toolName) html += dt('Tool') + dd(cp.trigger.toolName);
  if (cp.trigger.toolCallId) html += dt('Tool Call ID') + dd(cp.trigger.toolCallId);
  html += dt('Parent') + dd(cp.parentId || '(none)');
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

function dt(label) { return '<dt>' + label + '</dt>'; }
function dd(value) { return '<dd>' + escapeHtml(String(value)) + '</dd>'; }

// ── Init ──

loadSessions();
</script>
</body>
</html>`;
