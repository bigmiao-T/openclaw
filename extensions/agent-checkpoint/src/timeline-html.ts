/** Inline HTML/CSS/JS SPA for the checkpoint timeline viewer. */
export const TIMELINE_HTML = /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agent Checkpoint Timeline</title>
<style>
  :root {
    --bg: #ffffff;
    --surface: #f6f8fa;
    --border: #d0d7de;
    --text: #1f2328;
    --text-muted: #656d76;
    --accent: #0969da;
    --green: #1a7f37;
    --red: #cf222e;
    --orange: #9a6700;
    --timeline-line: #d0d7de;
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

  /* Conversation event nodes */
  .timeline-item.user .timeline-node { background: var(--accent); }
  .timeline-item.assistant .timeline-node { background: var(--green); }
  .timeline-item.tool-call .timeline-node {
    background: var(--border);
    border-radius: 2px;
    width: 10px; height: 10px;
    left: -22px; top: 13px;
  }
  .timeline-item.tool-result .timeline-node {
    background: var(--border);
    width: 8px; height: 8px;
    left: -21px; top: 14px;
  }
  .timeline-item.tool-result.error .timeline-node { background: var(--red); }
  .timeline-item.compaction .timeline-node {
    background: var(--text-muted);
    width: 8px; height: 8px;
    left: -21px; top: 14px;
    border-radius: 2px;
  }
  .timeline-content-preview {
    font-size: 12px;
    color: var(--text-muted);
    margin-top: 2px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 340px;
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
  .badge-tool { background: rgba(9,105,218,0.1); color: var(--accent); }
  .badge-manual { background: rgba(154,103,0,0.1); color: var(--orange); }
  .badge-session { background: rgba(26,127,55,0.1); color: var(--green); }
  .badge-error { background: rgba(207,34,46,0.1); color: var(--red); }
  .badge-child { background: rgba(130,80,223,0.1); color: var(--purple); }
  .badge-action { background: rgba(9,105,218,0.08); color: var(--text-muted); }

  :root { --purple: #8250df; }

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
  .toast.success { background: rgba(26,127,55,0.1); color: var(--green); border: 1px solid var(--green); }
  .toast.error { background: rgba(207,34,46,0.1); color: var(--red); border: 1px solid var(--red); }
  .toast.info { background: rgba(9,105,218,0.1); color: var(--accent); border: 1px solid var(--accent); }
  @keyframes toast-in { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: translateY(0); } }

  /* Confirm dialog */
  .modal-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.3);
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

let currentTimelineEvents = [];

function selectSession(agentId, sessionId) {
  currentSession = allSessions.find(s => s.agentId === agentId && s.sessionId === sessionId) || null;
  sessionSelect.value = agentId + '/' + sessionId;
  loadTimeline(agentId, sessionId);
}

sessionSelect.addEventListener('change', () => {
  const val = sessionSelect.value;
  if (!val) return;
  const [agentId, ...rest] = val.split('/');
  const sessionId = rest.join('/');
  selectSession(agentId, sessionId);
});

// ── Timeline ──

async function loadTimeline(agentId, sessionId) {
  timelinePanel.innerHTML = '<div class="empty-state loading">Loading timeline...</div>';
  detailPanel.innerHTML = '<div class="empty-state">Select a checkpoint to view details</div>';
  activeCheckpointId = null;

  try {
    const data = await fetchJSON('/api/sessions/' + agentId + '/' + sessionId + '/timeline');
    const events = data.events || [];

    // Extract checkpoints for detail panel
    currentCheckpoints = events.filter(e => e.type === 'checkpoint' && e.checkpoint).map(e => e.checkpoint);
    currentTimelineEvents = events;

    if (events.length === 0) {
      timelinePanel.innerHTML = '<div class="empty-state">No events in this session</div>';
      return;
    }

    renderTimelineEvents(events);
  } catch (e) {
    timelinePanel.innerHTML = '<div class="empty-state">Error: ' + e.message + '</div>';
  }
}

function renderTimelineEvents(events) {
  // Show newest first
  const sorted = [...events].reverse();

  let html = '<div class="timeline">';
  for (const ev of sorted) {
    html += renderEventItem(ev);
  }
  html += '</div>';
  timelinePanel.innerHTML = html;

  // Click handlers — only checkpoint items are clickable
  timelinePanel.querySelectorAll('.timeline-item[data-id]').forEach(el => {
    el.addEventListener('click', () => selectCheckpoint(el.dataset.id));
  });
}

function renderEventItem(ev) {
  const time = formatTime(ev.timestamp);

  if (ev.type === 'checkpoint') {
    const cp = ev.checkpoint;
    const isManual = cp?.trigger?.type === 'manual';
    const isSession = cp?.trigger?.type === 'session_start';
    let cls = 'timeline-item';
    if (isManual) cls += ' manual';
    else if (isSession) cls += ' session-start';

    let html = '<div class="' + cls + '" data-id="' + escapeAttr(ev.checkpointId) + '">';
    html += '<div class="timeline-node"></div>';
    html += '<div class="timeline-time">' + time + '</div>';
    html += '<div class="timeline-title">' + escapeHtml(ev.content) + '</div>';
    html += '<div class="timeline-meta">';
    if (cp) html += '<span>' + cp.snapshot.filesChanged.length + ' files</span>';
    html += '<span class="badge badge-manual">checkpoint</span>';
    if (ev.toolName) html += '<span class="badge badge-tool">' + escapeHtml(ev.toolName) + '</span>';
    html += '</div></div>';
    return html;
  }

  if (ev.type === 'user_message') {
    let html = '<div class="timeline-item user">';
    html += '<div class="timeline-node"></div>';
    html += '<div class="timeline-time">' + time + '</div>';
    html += '<div class="timeline-title">User</div>';
    html += '<div class="timeline-content-preview">' + escapeHtml(ev.content) + '</div>';
    html += '</div>';
    return html;
  }

  if (ev.type === 'assistant_reply') {
    let html = '<div class="timeline-item assistant">';
    html += '<div class="timeline-node"></div>';
    html += '<div class="timeline-time">' + time + '</div>';
    html += '<div class="timeline-title">Assistant</div>';
    html += '<div class="timeline-content-preview">' + escapeHtml(ev.content) + '</div>';
    html += '</div>';
    return html;
  }

  if (ev.type === 'tool_call') {
    let html = '<div class="timeline-item tool-call">';
    html += '<div class="timeline-node"></div>';
    html += '<div class="timeline-time">' + time + '</div>';
    html += '<div class="timeline-title">Tool: ' + escapeHtml(ev.toolName || ev.content) + '</div>';
    html += '</div>';
    return html;
  }

  if (ev.type === 'tool_result') {
    let html = '<div class="timeline-item tool-result' + (ev.isError ? ' error' : '') + '">';
    html += '<div class="timeline-node"></div>';
    html += '<div class="timeline-time">' + time + '</div>';
    html += '<div class="timeline-title">' + (ev.toolName ? ev.toolName + ' ' : '') + 'Result</div>';
    html += '<div class="timeline-content-preview' + (ev.isError ? ' error' : '') + '">' + escapeHtml(ev.content) + '</div>';
    html += '</div>';
    return html;
  }

  if (ev.type === 'session_start') {
    let html = '<div class="timeline-item session-start">';
    html += '<div class="timeline-node"></div>';
    html += '<div class="timeline-time">' + time + '</div>';
    html += '<div class="timeline-title">Session Started</div>';
    html += '</div>';
    return html;
  }

  if (ev.type === 'compaction') {
    let html = '<div class="timeline-item compaction">';
    html += '<div class="timeline-node"></div>';
    html += '<div class="timeline-time">' + time + '</div>';
    html += '<div class="timeline-title">Context Compacted</div>';
    html += '<div class="timeline-content-preview">' + escapeHtml(ev.content) + '</div>';
    html += '</div>';
    return html;
  }

  return '';
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
        let msg = 'Restored to ' + data.checkpointId;
        if (data.triggerInfo) msg += ' — ' + data.triggerInfo;
        if (data.hint) msg += ' ' + data.hint;
        showToast(msg, 'success');
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

// ── Init ──

loadSessions();
</script>
</body>
</html>`;
