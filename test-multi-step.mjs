#!/usr/bin/env node
/**
 * Simulate a multi-step agent task that creates multiple checkpoints,
 * then start the timeline viewer to verify display.
 */
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

// Use a temporary directory for this test
const tmpDir = path.join(os.tmpdir(), `cp-multi-test-${Date.now()}`);
const workspaceDir = path.join(tmpDir, "workspace");
const storagePath = path.join(tmpDir, "storage");

await fs.mkdir(workspaceDir, { recursive: true });

// Dynamically import the plugin modules (they're TypeScript, need jiti or similar)
// Instead, we'll directly manipulate the checkpoint data on disk to simulate

const META_ROOT = path.join(storagePath, "meta");
const SNAPSHOTS_ROOT = path.join(storagePath, "snapshots");

async function writeJson(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf8");
}

// Simulate a multi-step coding task session
const agentId = "main";
const sessionId = "coding-task-2026-04-08";
const checkpoints = [];

const steps = [
  { seq: 1, trigger: "start", toolName: null, files: ["src/index.ts"], summary: "Session started" },
  { seq: 2, trigger: "write", toolName: "write", files: ["src/index.ts", "src/config.ts"], summary: "Created initial project structure" },
  { seq: 3, trigger: "write", toolName: "write", files: ["src/utils.ts"], summary: "Added utility functions" },
  { seq: 4, trigger: "exec", toolName: "exec", files: ["package.json", "pnpm-lock.yaml"], summary: "Installed dependencies" },
  { seq: 5, trigger: "write", toolName: "write", files: ["src/api.ts", "src/types.ts"], summary: "Implemented API layer" },
  { seq: 6, trigger: "write", toolName: "write", files: ["src/api.test.ts"], summary: "Added tests" },
  { seq: 7, trigger: "exec", toolName: "exec", files: [], summary: "Ran tests - all passed", success: true },
  { seq: 8, trigger: "write", toolName: "write", files: ["src/api.ts", "src/error-handler.ts"], summary: "Added error handling" },
  { seq: 9, trigger: "exec", toolName: "exec", files: [], summary: "Ran tests - 1 failure", success: false, error: "TypeError: Cannot read property 'status' of undefined" },
  { seq: 10, trigger: "write", toolName: "write", files: ["src/api.ts"], summary: "Fixed error handler bug" },
  { seq: 11, trigger: "exec", toolName: "exec", files: [], summary: "Ran tests - all passed", success: true },
  { seq: 12, trigger: "manual", toolName: "checkpoint", files: ["src/index.ts", "src/api.ts", "src/config.ts", "src/utils.ts", "src/types.ts", "src/error-handler.ts", "src/api.test.ts", "package.json"], summary: "Manual checkpoint before refactor" },
];

let parentId = null;
const baseTime = new Date("2026-04-08T10:00:00Z");

for (const step of steps) {
  const seqStr = String(step.seq).padStart(3, "0");
  const triggerAbbr = step.trigger === "start" ? "start" : step.trigger === "manual" ? "manual" : step.toolName?.slice(0, 16).toLowerCase().replace(/[^a-z0-9]/g, "-") || "tool";
  const cpId = `${agentId}-${sessionId.slice(0, 6)}-${seqStr}-${triggerAbbr}`;

  const snapshotRef = cpId;

  // Create snapshot directory with some files
  const snapshotDir = path.join(SNAPSHOTS_ROOT, snapshotRef);
  await fs.mkdir(snapshotDir, { recursive: true });
  for (const f of step.files) {
    const filePath = path.join(snapshotDir, f);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, `// ${f} - step ${step.seq}\n// ${step.summary}\n`);
  }

  const meta = {
    id: cpId,
    parentId,
    sessionId,
    agentId,
    runId: "run-001",
    trigger: {
      type: step.trigger === "start" ? "session_start" : step.trigger === "manual" ? "manual" : "after_tool_call",
      ...(step.toolName ? { toolName: step.toolName } : {}),
    },
    snapshot: {
      backendType: "copy",
      snapshotRef,
      filesChanged: step.files,
      changeSummary: step.summary,
    },
    transcript: { messageCount: step.seq * 2, byteOffset: step.seq * 500 },
    createdAt: new Date(baseTime.getTime() + step.seq * 120000).toISOString(), // 2 min apart
    toolDurationMs: Math.floor(Math.random() * 5000) + 500,
    toolResult: step.success !== undefined ? { success: step.success, ...(step.error ? { errorMessage: step.error } : {}) } : { success: true },
  };

  // Save checkpoint meta
  await writeJson(path.join(META_ROOT, agentId, sessionId, cpId, "meta.json"), meta);

  checkpoints.push(cpId);
  parentId = cpId;
}

// Write manifest
await writeJson(path.join(META_ROOT, agentId, sessionId, "manifest.json"), {
  sessionId,
  agentId,
  checkpoints,
  currentHead: checkpoints.at(-1),
});

// Also create a sub-agent session with a few checkpoints
const childSessionId = "subagent:review-code-abc123";
const childCheckpoints = [];
let childParentId = null;

const childSteps = [
  { seq: 1, trigger: "start", toolName: null, files: ["src/api.ts", "src/types.ts"], summary: "Sub-agent started code review" },
  { seq: 2, trigger: "read", toolName: "read", files: ["src/api.ts"], summary: "Read API source" },
  { seq: 3, trigger: "write", toolName: "write", files: ["src/api.ts"], summary: "Applied review suggestions" },
];

for (const step of childSteps) {
  const seqStr = String(step.seq).padStart(3, "0");
  const triggerAbbr = step.trigger === "start" ? "start" : step.toolName?.slice(0, 16).toLowerCase().replace(/[^a-z0-9]/g, "-") || "tool";
  const cpId = `${agentId}-${childSessionId.slice(0, 6)}-${seqStr}-${triggerAbbr}`;
  const snapshotRef = cpId;

  const snapshotDir = path.join(SNAPSHOTS_ROOT, snapshotRef);
  await fs.mkdir(snapshotDir, { recursive: true });
  for (const f of step.files) {
    const filePath = path.join(snapshotDir, f);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, `// ${f} - child step ${step.seq}\n`);
  }

  const meta = {
    id: cpId,
    parentId: childParentId,
    sessionId: childSessionId,
    agentId,
    runId: "run-002",
    trigger: {
      type: step.trigger === "start" ? "session_start" : "after_tool_call",
      ...(step.toolName ? { toolName: step.toolName } : {}),
    },
    snapshot: {
      backendType: "copy",
      snapshotRef,
      filesChanged: step.files,
      changeSummary: step.summary,
    },
    transcript: { messageCount: step.seq * 2, byteOffset: step.seq * 300 },
    createdAt: new Date(baseTime.getTime() + (step.seq + 5) * 120000).toISOString(),
    toolDurationMs: Math.floor(Math.random() * 3000) + 200,
    toolResult: { success: true },
  };

  await writeJson(path.join(META_ROOT, agentId, childSessionId, cpId, "meta.json"), meta);
  childCheckpoints.push(cpId);
  childParentId = cpId;
}

// Child manifest with parent link
await writeJson(path.join(META_ROOT, agentId, childSessionId, "manifest.json"), {
  sessionId: childSessionId,
  agentId,
  checkpoints: childCheckpoints,
  currentHead: childCheckpoints.at(-1),
  parentSession: { agentId, sessionId, sessionKey: `agent:main:explicit:${sessionId}` },
});

// Update parent manifest with child link
const parentManifest = JSON.parse(await fs.readFile(path.join(META_ROOT, agentId, sessionId, "manifest.json"), "utf8"));
parentManifest.childSessions = [
  { agentId, sessionId: childSessionId, sessionKey: `agent:main:subagent:review-code-abc123` },
];
await writeJson(path.join(META_ROOT, agentId, sessionId, "manifest.json"), parentManifest);

console.log(`\nCreated test data:`);
console.log(`  Storage: ${storagePath}`);
console.log(`  Parent session: ${agentId}/${sessionId} — ${checkpoints.length} checkpoints`);
console.log(`  Child session: ${agentId}/${childSessionId} — ${childCheckpoints.length} checkpoints`);
console.log(`\nCheckpoints:`);
for (const cp of checkpoints) console.log(`  ${cp}`);
console.log(`\nChild checkpoints:`);
for (const cp of childCheckpoints) console.log(`  ${cp}`);

// Now start the timeline server pointing at this test data
console.log(`\n--- Starting timeline viewer ---\n`);

// Override paths for test-timeline.mjs
process.env.CP_META_ROOT = META_ROOT;
process.env.CP_SNAPSHOTS_ROOT = SNAPSHOTS_ROOT;

// Inline a minimal server
import http from "node:http";

const timelineServerPath = path.resolve("extensions/agent-checkpoint/src/timeline-server.ts");
const tsSource = await fs.readFile(timelineServerPath, "utf8");
const htmlMatch = tsSource.match(/const TIMELINE_HTML = \/\* html \*\/ `([\s\S]*?)`;/);
if (!htmlMatch) {
  console.error("Could not extract TIMELINE_HTML from timeline-server.ts");
  process.exit(1);
}
// The regex extracts raw source text from the template literal.
// Process escape sequences to match what JS would produce at runtime.
function processTemplateEscapes(raw) {
  let result = '';
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === '\\' && i + 1 < raw.length) {
      const next = raw[i + 1];
      if (next === 'n') { result += '\n'; i++; }
      else if (next === 't') { result += '\t'; i++; }
      else if (next === '\\') { result += '\\'; i++; }
      else if (next === "'") { result += "'"; i++; }
      else if (next === '"') { result += '"'; i++; }
      else if (next === 'u') {
        // Unicode escape: \uXXXX
        const hex = raw.slice(i + 2, i + 6);
        if (/^[0-9a-fA-F]{4}$/.test(hex)) {
          result += String.fromCharCode(parseInt(hex, 16));
          i += 5;
        } else {
          result += raw[i];
        }
      } else {
        result += raw[i];
      }
    } else {
      result += raw[i];
    }
  }
  return result;
}
const TIMELINE_HTML = processTemplateEscapes(htmlMatch[1]);

async function readManifest(aid, sid) {
  try {
    return JSON.parse(await fs.readFile(path.join(META_ROOT, aid, sid, "manifest.json"), "utf8"));
  } catch { return null; }
}

async function listSessions() {
  const results = [];
  try {
    const agents = await fs.readdir(META_ROOT, { withFileTypes: true });
    for (const a of agents) {
      if (!a.isDirectory()) continue;
      const sessions = await fs.readdir(path.join(META_ROOT, a.name), { withFileTypes: true });
      for (const s of sessions) {
        if (!s.isDirectory()) continue;
        const manifest = await readManifest(a.name, s.name);
        results.push({
          agentId: a.name,
          sessionId: s.name,
          checkpointCount: manifest?.checkpoints?.length ?? 0,
          parentSession: manifest?.parentSession ?? null,
          childSessions: manifest?.childSessions ?? [],
        });
      }
    }
  } catch { /* no data */ }
  return results;
}

async function listCheckpoints(aid, sid) {
  const manifestPath = path.join(META_ROOT, aid, sid, "manifest.json");
  try {
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    const results = [];
    for (const id of manifest.checkpoints) {
      try {
        const meta = JSON.parse(
          await fs.readFile(path.join(META_ROOT, aid, sid, id, "meta.json"), "utf8")
        );
        results.push(meta);
      } catch { /* skip */ }
    }
    return results;
  } catch { return []; }
}

async function getDiff(aid, sid, cpId) {
  try {
    const meta = JSON.parse(
      await fs.readFile(path.join(META_ROOT, aid, sid, cpId, "meta.json"), "utf8")
    );
    const snapshotDir = path.join(SNAPSHOTS_ROOT, meta.snapshot.snapshotRef);
    const files = [];
    async function walk(dir, prefix) {
      try {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const e of entries) {
          const rel = prefix ? `${prefix}/${e.name}` : e.name;
          if (e.isDirectory()) await walk(path.join(dir, e.name), rel);
          else { files.push(rel); if (files.length >= 100) return; }
        }
      } catch {}
    }
    await walk(snapshotDir, "");
    return `Snapshot ${meta.snapshot.snapshotRef}\n${files.length} files:\n${files.join("\n")}`;
  } catch (e) { return `Error: ${e.message}`; }
}

const PORT = parseInt(process.argv[2] || "3456", 10);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1`);
  const pathname = url.pathname;
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  try {
    if (pathname === "/" || pathname === "/index.html") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(TIMELINE_HTML);
      return;
    }
    if (pathname === "/api/sessions") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(await listSessions()));
      return;
    }
    const cpMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/(.+)\/checkpoints$/);
    if (cpMatch) {
      const cps = await listCheckpoints(cpMatch[1], decodeURIComponent(cpMatch[2]));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(cps));
      return;
    }
    const diffMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/(.+)\/checkpoints\/([^/]+)\/diff$/);
    if (diffMatch) {
      const diff = await getDiff(diffMatch[1], decodeURIComponent(diffMatch[2]), diffMatch[3]);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ diff }));
      return;
    }
    // POST /api/restore — simulate restore
    if (req.method === "POST" && pathname === "/api/restore") {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const { agentId: aid, sessionId: sid, checkpointId: cpId, scope: sc } = body;

      // Simulate: trim manifest checkpoints after the restored one
      const manifestPath = path.join(META_ROOT, aid, sid, "manifest.json");
      try {
        const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
        const idx = manifest.checkpoints.indexOf(cpId);
        if (idx >= 0) {
          manifest.checkpoints = manifest.checkpoints.slice(0, idx + 1);
          manifest.currentHead = cpId;
          await fs.mkdir(path.dirname(manifestPath), { recursive: true });
          await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          ok: true,
          checkpointId: cpId,
          scope: sc || "files",
          filesRestored: true,
          transcriptRestored: sc === "all",
        }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(e) }));
      }
      return;
    }

    // POST /api/continue — simulate agent execution with SSE
    if (req.method === "POST" && pathname === "/api/continue") {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const { agentId: aid, sessionId: sid, checkpointId: cpId, message: msg } = body;

      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      });

      const sendSSE = (event, data) => {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };

      // Simulate restore + agent execution with delays
      sendSSE("status", { phase: "restoring", message: "Restoring workspace to checkpoint..." });
      await new Promise(r => setTimeout(r, 800));

      // Actually trim manifest
      const manifestPath = path.join(META_ROOT, aid, sid, "manifest.json");
      try {
        const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
        const idx = manifest.checkpoints.indexOf(cpId);
        if (idx >= 0) {
          manifest.checkpoints = manifest.checkpoints.slice(0, idx + 1);
          manifest.currentHead = cpId;
          await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
        }
      } catch {}

      sendSSE("status", { phase: "restored", message: `Restored to ${cpId}` });
      await new Promise(r => setTimeout(r, 500));

      sendSSE("status", { phase: "starting", message: "Starting agent execution..." });
      await new Promise(r => setTimeout(r, 600));

      sendSSE("status", { phase: "running", message: "Agent is running...", runId: "sim-run-001" });
      await new Promise(r => setTimeout(r, 2000));

      sendSSE("status", {
        phase: "done",
        message: "Agent completed successfully.",
        result: `Task resumed from checkpoint ${cpId}.\n\nCompleted remaining steps:\n- Fixed error in src/api.ts\n- All tests passing (8/8)\n- Code committed to branch feature/api-refactor`,
      });
      sendSSE("done", {});
      res.end();
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  } catch (error) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: String(error) }));
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Timeline viewer running at: http://127.0.0.1:${PORT}`);
  console.log(`Press Ctrl+C to stop.\n`);
});
