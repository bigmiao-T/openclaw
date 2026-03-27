// Checkpoint Viewer - Timeline SPA
(function () {
  "use strict";

  const API_BASE = "/plugins/checkpoint/api";
  let selectedCheckpoint = null;

  async function fetchJson(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  async function postJson(url, body) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  function formatTime(iso) {
    const d = new Date(iso);
    return d.toLocaleString();
  }

  function formatRelativeTime(iso) {
    const diff = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  }

  // Load sessions into dropdown
  async function loadSessions() {
    const select = document.getElementById("session-select");
    try {
      const data = await fetchJson(`${API_BASE}/sessions`);
      select.innerHTML = "";

      if (data.sessions.length === 0) {
        select.innerHTML = '<option value="">No sessions</option>';
        showEmpty("No checkpoint sessions found.");
        return;
      }

      for (const s of data.sessions) {
        const opt = document.createElement("option");
        opt.value = `${s.agentId}|${s.sessionId}`;
        opt.textContent = `${s.agentId} / ${s.sessionId.slice(0, 8)}...`;
        select.appendChild(opt);
      }

      select.addEventListener("change", () => loadCheckpoints());
      loadCheckpoints();
    } catch (err) {
      showEmpty(`Failed to load sessions: ${err.message}`);
    }
  }

  // Load checkpoints for selected session
  async function loadCheckpoints() {
    const select = document.getElementById("session-select");
    const value = select.value;
    if (!value) return;

    const [agentId, sessionId] = value.split("|");
    const timeline = document.getElementById("timeline");

    try {
      const data = await fetchJson(
        `${API_BASE}/sessions/${sessionId}?agentId=${encodeURIComponent(agentId)}`,
      );

      if (data.checkpoints.length === 0) {
        showEmpty("No checkpoints in this session.");
        return;
      }

      // Render timeline (newest first)
      const checkpoints = [...data.checkpoints].reverse();
      timeline.innerHTML = "";

      for (const cp of checkpoints) {
        const node = document.createElement("div");
        node.className = "checkpoint-node";
        if (cp.toolResult && !cp.toolResult.success) {
          node.className += " error";
        }
        if (cp.trigger.type === "manual") {
          node.className += " manual";
        }

        const toolName = cp.trigger.toolName || cp.trigger.type;
        const fileCount = cp.git.filesChanged.length;

        node.innerHTML = `
          <div class="checkpoint-header">
            <span class="checkpoint-tool">${escapeHtml(toolName)}</span>
            <span class="checkpoint-time">${formatRelativeTime(cp.createdAt)}</span>
          </div>
          <div class="checkpoint-stats">
            <span>${fileCount} file${fileCount !== 1 ? "s" : ""} changed</span>
            ${cp.toolDurationMs ? `<span>${cp.toolDurationMs}ms</span>` : ""}
            ${cp.toolResult && !cp.toolResult.success ? '<span style="color: var(--accent-error)">ERROR</span>' : ""}
          </div>
          <div class="checkpoint-id">${cp.id}</div>
        `;

        node.addEventListener("click", () => showDetail(cp, agentId, sessionId));
        timeline.appendChild(node);
      }

      // Hide detail panel
      hideDetail();
    } catch (err) {
      showEmpty(`Failed to load checkpoints: ${err.message}`);
    }
  }

  // Show checkpoint detail
  function showDetail(cp, agentId, sessionId) {
    selectedCheckpoint = { ...cp, agentId, sessionId };

    // Highlight selected node
    document.querySelectorAll(".checkpoint-node").forEach((n) => n.classList.remove("selected"));
    event.currentTarget.classList.add("selected");

    const panel = document.getElementById("detail-panel");
    const title = document.getElementById("detail-title");
    const content = document.getElementById("detail-content");

    panel.classList.remove("hidden");
    title.textContent = cp.trigger.toolName || cp.trigger.type;

    const filesHtml = cp.git.filesChanged.map((f) => `<li>${escapeHtml(f)}</li>`).join("");

    content.innerHTML = `
      <div class="detail-section">
        <h3>Metadata</h3>
        <pre>${escapeHtml(
          JSON.stringify(
            {
              id: cp.id,
              createdAt: formatTime(cp.createdAt),
              trigger: cp.trigger,
              runId: cp.runId,
              toolDurationMs: cp.toolDurationMs,
              toolResult: cp.toolResult,
            },
            null,
            2,
          ),
        )}</pre>
      </div>
      <div class="detail-section">
        <h3>Files Changed (${cp.git.filesChanged.length})</h3>
        ${filesHtml ? `<ul class="file-list">${filesHtml}</ul>` : "<p>No files changed</p>"}
      </div>
      <div class="detail-section">
        <h3>Git</h3>
        <pre>Commit: ${cp.git.commitSha}
Tree: ${cp.git.treeSha}
${cp.git.diffStat || ""}</pre>
      </div>
      <div class="detail-section">
        <h3>Transcript</h3>
        <pre>Messages: ${cp.transcript.messageCount}
Byte offset: ${cp.transcript.byteOffset}</pre>
      </div>
      <button class="btn-restore" onclick="restoreCheckpoint()">Restore to this checkpoint</button>
    `;
  }

  // Restore checkpoint
  window.restoreCheckpoint = async function () {
    if (!selectedCheckpoint) return;

    const scope = prompt("Restore scope (files, transcript, all):", "all");
    if (!scope) return;

    try {
      const result = await postJson(`${API_BASE}/checkpoints/${selectedCheckpoint.id}/restore`, {
        agentId: selectedCheckpoint.agentId,
        sessionId: selectedCheckpoint.sessionId,
        workspaceDir: selectedCheckpoint.workspaceDir || "",
        scope,
      });
      alert(`Restored to checkpoint ${selectedCheckpoint.id}\nScope: ${scope}`);
      loadCheckpoints();
    } catch (err) {
      alert(`Restore failed: ${err.message}`);
    }
  };

  function hideDetail() {
    document.getElementById("detail-panel").classList.add("hidden");
    selectedCheckpoint = null;
  }

  function showEmpty(message) {
    document.getElementById("timeline").innerHTML =
      `<div class="empty-state">${escapeHtml(message)}</div>`;
    hideDetail();
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = String(str);
    return div.innerHTML;
  }

  // Initialize
  loadSessions();
})();
