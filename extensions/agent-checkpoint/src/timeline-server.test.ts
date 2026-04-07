import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CopyBackend } from "./copy-backend.js";
import { CheckpointEngine } from "./engine.js";
import { CheckpointStore } from "./store.js";
import { startTimelineServer, type TimelineServer } from "./timeline-server.js";
import type { CheckpointPluginConfig } from "./types.js";

describe("TimelineServer", () => {
  let tmpDir: string;
  let workspaceDir: string;
  let engine: CheckpointEngine;
  let store: CheckpointStore;
  let server: TimelineServer;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cp-timeline-test-"));
    workspaceDir = path.join(tmpDir, "workspace");
    const storagePath = path.join(tmpDir, "storage");
    await fs.mkdir(workspaceDir, { recursive: true });

    const config: CheckpointPluginConfig = {
      enabled: true,
      storagePath,
      backendType: "copy",
      backendConfig: {},
      triggerOn: "all_tools",
      excludeTools: [],
      maxCheckpointsPerSession: 50,
      retentionDays: 7,
      restoreDefaultScope: "files",
    };

    store = new CheckpointStore({ rootDir: path.join(storagePath, "meta") });
    const backend = new CopyBackend({ storageDir: storagePath });
    engine = new CheckpointEngine({ store, backend, config });

    server = await startTimelineServer({ engine, store, port: 0 });
  });

  afterEach(async () => {
    await server.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function fetchJSON(urlPath: string) {
    const res = await fetch(`${server.url}${urlPath}`);
    expect(res.ok).toBe(true);
    return res.json();
  }

  it("serves the HTML UI at /", async () => {
    const res = await fetch(server.url);
    expect(res.ok).toBe(true);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("Checkpoint Timeline");
  });

  it("returns empty sessions list", async () => {
    const data = await fetchJSON("/api/sessions");
    expect(data).toEqual([]);
  });

  it("returns sessions after creating checkpoints", async () => {
    await fs.writeFile(path.join(workspaceDir, "f.txt"), "data");
    await engine.createCheckpoint({
      agentId: "a1",
      sessionId: "s1",
      runId: "r1",
      workspaceDir,
      trigger: { type: "manual" },
    });

    const sessions = await fetchJSON("/api/sessions");
    expect(sessions).toHaveLength(1);
    expect(sessions[0].agentId).toBe("a1");
    expect(sessions[0].sessionId).toBe("s1");
    expect(sessions[0].checkpointCount).toBe(1);
    expect(sessions[0].parentSession).toBeNull();
    expect(sessions[0].childSessions).toEqual([]);
  });

  it("returns checkpoints for a session", async () => {
    await fs.writeFile(path.join(workspaceDir, "f.txt"), "data");
    await engine.createCheckpoint({
      agentId: "a1",
      sessionId: "s1",
      runId: "r1",
      workspaceDir,
      trigger: { type: "manual" },
    });

    const checkpoints = await fetchJSON("/api/sessions/a1/s1/checkpoints");
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0].agentId).toBe("a1");
    expect(checkpoints[0].trigger.type).toBe("manual");
  });

  it("returns diff for a checkpoint", async () => {
    await fs.writeFile(path.join(workspaceDir, "hello.txt"), "world");
    const cp = await engine.createCheckpoint({
      agentId: "a1",
      sessionId: "s1",
      runId: "r1",
      workspaceDir,
      trigger: { type: "manual" },
    });

    const data = await fetchJSON(`/api/sessions/a1/s1/checkpoints/${cp.id}/diff`);
    expect(data.diff).toContain("hello.txt");
  });

  it("returns 404 for unknown routes", async () => {
    const res = await fetch(`${server.url}/api/unknown`);
    expect(res.status).toBe(404);
  });
});
