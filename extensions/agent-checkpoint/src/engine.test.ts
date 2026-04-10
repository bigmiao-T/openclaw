import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CopyBackend } from "./copy-backend.js";
import { CheckpointEngine } from "./engine.js";
import { CheckpointStore } from "./store.js";
import type { CheckpointPluginConfig } from "./types.js";

describe("CheckpointEngine", () => {
  let tmpDir: string;
  let workspaceDir: string;
  let engine: CheckpointEngine;
  let store: CheckpointStore;

  const defaultConfig: CheckpointPluginConfig = {
    enabled: true,
    storagePath: "", // set in beforeEach
    backendType: "copy",
    backendConfig: {},
    triggerOn: "auto",
    excludeTools: ["Read", "Glob"],
    maxCheckpointsPerSession: 50,
    retentionDays: 7,
    restoreDefaultScope: "files",
  };

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cp-engine-test-"));
    workspaceDir = path.join(tmpDir, "workspace");
    const storagePath = path.join(tmpDir, "storage");
    await fs.mkdir(workspaceDir, { recursive: true });

    const config = { ...defaultConfig, storagePath };

    store = new CheckpointStore({ rootDir: path.join(storagePath, "meta") });
    const backend = new CopyBackend({ storageDir: storagePath });

    engine = new CheckpointEngine({ store, backend, config });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function writeFile(rel: string, content: string) {
    const full = path.join(workspaceDir, rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content, "utf8");
  }

  async function readFile(rel: string): Promise<string> {
    return fs.readFile(path.join(workspaceDir, rel), "utf8");
  }

  describe("shouldCreateCheckpoint", () => {
    it("returns true for non-excluded tools", () => {
      expect(engine.shouldCreateCheckpoint("Write")).toBe(true);
      expect(engine.shouldCreateCheckpoint("Edit")).toBe(true);
      expect(engine.shouldCreateCheckpoint("Bash")).toBe(true);
    });

    it("returns false for excluded tools (case-insensitive)", () => {
      expect(engine.shouldCreateCheckpoint("Read")).toBe(false);
      expect(engine.shouldCreateCheckpoint("read")).toBe(false);
      expect(engine.shouldCreateCheckpoint("Glob")).toBe(false);
    });
  });

  describe("createCheckpoint", () => {
    it("creates a checkpoint and stores metadata", async () => {
      await writeFile("main.ts", "code");

      const meta = await engine.createCheckpoint({
        agentId: "a1",
        sessionId: "s1",
        runId: "r1",
        workspaceDir,
        trigger: { type: "before_tool_call", toolName: "Write" },
      });

      // ID format: {agent}-{session_prefix}-{seq:03d}-{trigger_abbr}-{ts}
      expect(meta.id).toMatch(/^a1-s1-001-write-\d+$/);
      expect(meta.agentId).toBe("a1");
      expect(meta.sessionId).toBe("s1");
      expect(meta.trigger.toolName).toBe("Write");
      expect(meta.snapshot.filesChanged).toContain("main.ts");
      expect(meta.parentId).toBeNull();
    });

    it("chains checkpoints with parentId", async () => {
      await writeFile("a.txt", "v1");
      const cp1 = await engine.createCheckpoint({
        agentId: "a1",
        sessionId: "s1",
        runId: "r1",
        workspaceDir,
        trigger: { type: "manual" },
      });

      await writeFile("a.txt", "v2");
      const cp2 = await engine.createCheckpoint({
        agentId: "a1",
        sessionId: "s1",
        runId: "r1",
        workspaceDir,
        trigger: { type: "manual" },
      });

      expect(cp1.id).toMatch(/^a1-s1-001-manual-\d+$/);
      expect(cp2.id).toMatch(/^a1-s1-002-manual-\d+$/);
      expect(cp2.parentId).toBe(cp1.id);
    });

    it("stores toolDurationMs and toolResult", async () => {
      await writeFile("x.txt", "data");

      const meta = await engine.createCheckpoint({
        agentId: "a1",
        sessionId: "s1",
        runId: "r1",
        workspaceDir,
        trigger: { type: "before_tool_call", toolName: "Bash" },
        toolDurationMs: 1500,
        toolResult: { success: false, errorMessage: "exit code 1" },
      });

      expect(meta.toolDurationMs).toBe(1500);
      expect(meta.toolResult?.success).toBe(false);
      expect(meta.toolResult?.errorMessage).toBe("exit code 1");
    });
  });

  describe("restoreCheckpoint", () => {
    it("restores workspace files to checkpoint state", async () => {
      await writeFile("file.txt", "original");
      const cp = await engine.createCheckpoint({
        agentId: "a1",
        sessionId: "s1",
        runId: "r1",
        workspaceDir,
        trigger: { type: "manual" },
      });

      await writeFile("file.txt", "modified");
      await writeFile("new.txt", "added");

      const result = await engine.restoreCheckpoint({
        agentId: "a1",
        sessionId: "s1",
        checkpointId: cp.id,
        workspaceDir,
      });

      expect(result.filesRestored).toBe(true);
      expect(result.scope).toBe("files");
      expect(await readFile("file.txt")).toBe("original");
    });

    it("trims manifest to restored checkpoint", async () => {
      await writeFile("f.txt", "v1");
      const cp1 = await engine.createCheckpoint({
        agentId: "a1",
        sessionId: "s1",
        runId: "r1",
        workspaceDir,
        trigger: { type: "manual" },
      });

      await writeFile("f.txt", "v2");
      await engine.createCheckpoint({
        agentId: "a1",
        sessionId: "s1",
        runId: "r1",
        workspaceDir,
        trigger: { type: "manual" },
      });

      await engine.restoreCheckpoint({
        agentId: "a1",
        sessionId: "s1",
        checkpointId: cp1.id,
        workspaceDir,
      });

      const manifest = await store.getManifest("a1", "s1");
      expect(manifest?.checkpoints).toEqual([cp1.id]);
      expect(manifest?.currentHead).toBe(cp1.id);
    });

    it("throws for nonexistent checkpoint", async () => {
      await expect(
        engine.restoreCheckpoint({
          agentId: "a1",
          sessionId: "s1",
          checkpointId: "nope",
          workspaceDir,
        }),
      ).rejects.toThrow("not found");
    });

    it("forks transcript to new file when scope is all (compaction-safe)", async () => {
      const sessionsDir = path.join(tmpDir, "sessions");
      await fs.mkdir(sessionsDir, { recursive: true });
      const transcriptPath = path.join(sessionsDir, "session.jsonl");
      const line1 = JSON.stringify({ type: "session", timestamp: new Date().toISOString() }) + "\n";
      const line2 = JSON.stringify({ type: "message", message: { role: "user", content: "hello" } }) + "\n";
      await fs.writeFile(transcriptPath, line1 + line2);
      const originalContent = await fs.readFile(transcriptPath, "utf8");

      await writeFile("file.txt", "v1");
      const cp = await engine.createCheckpoint({
        agentId: "a1",
        sessionId: "s1",
        runId: "r1",
        workspaceDir,
        trigger: { type: "manual" },
        sessionTranscriptPath: transcriptPath,
      });

      expect(cp.transcript.snapshotFile).toBeDefined();

      // Simulate compaction: completely rewrite the original transcript
      await fs.writeFile(transcriptPath, '{"type":"compaction","summary":"compacted"}\n');

      let restoredPath: string | undefined;
      await writeFile("file.txt", "v2");
      const result = await engine.restoreCheckpoint({
        agentId: "a1",
        sessionId: "s1",
        checkpointId: cp.id,
        workspaceDir,
        scope: "all",
        sessionTranscriptPath: transcriptPath,
        onTranscriptRestored: async (newPath) => { restoredPath = newPath; },
      });

      expect(result.transcriptRestored).toBe(true);
      expect(result.filesRestored).toBe(true);
      // A new file should have been created (not overwriting the original)
      expect(restoredPath).toBeDefined();
      expect(restoredPath).not.toBe(transcriptPath);
      // New file has the original content plus a restore notice
      const restoredContent = await fs.readFile(restoredPath!, "utf8");
      expect(restoredContent).toContain(originalContent.trim());
      expect(restoredContent).toContain("custom_message");
      // Original file is untouched (still compacted)
      const originalNow = await fs.readFile(transcriptPath, "utf8");
      expect(originalNow).toContain("compaction");
    });
    it("full restore flow: files + transcript fork + orphan cleanup", async () => {
      // Setup session transcript
      const sessionsDir = path.join(tmpDir, "sessions");
      await fs.mkdir(sessionsDir, { recursive: true });
      const transcriptPath = path.join(sessionsDir, "s1.jsonl");
      const initialTranscript = '{"type":"session","timestamp":"2026-04-09T10:00:00Z"}\n'
        + '{"type":"message","message":{"role":"user","content":"step 1"}}\n';
      await fs.writeFile(transcriptPath, initialTranscript);

      // Create cp1: file=v1, transcript=2 lines
      await writeFile("data.txt", "v1");
      const cp1 = await engine.createCheckpoint({
        agentId: "a1", sessionId: "s1", runId: "r1", workspaceDir,
        trigger: { type: "before_tool_call", toolName: "write" },
        sessionTranscriptPath: transcriptPath,
      });

      // More activity after cp1
      await fs.appendFile(transcriptPath, '{"type":"message","message":{"role":"assistant","content":"done step 1"}}\n');
      await writeFile("data.txt", "v2");
      const cp2 = await engine.createCheckpoint({
        agentId: "a1", sessionId: "s1", runId: "r1", workspaceDir,
        trigger: { type: "before_tool_call", toolName: "write" },
        sessionTranscriptPath: transcriptPath,
      });

      // Even more activity after cp2
      await fs.appendFile(transcriptPath, '{"type":"message","message":{"role":"user","content":"step 3"}}\n');
      await writeFile("data.txt", "v3");
      await writeFile("extra.txt", "should disappear");

      // Verify pre-restore state
      const manifestBefore = await store.getManifest("a1", "s1");
      expect(manifestBefore?.checkpoints).toEqual([cp1.id, cp2.id]);

      // Restore to cp1 with scope "all"
      let restoredTranscriptPath: string | undefined;
      const result = await engine.restoreCheckpoint({
        agentId: "a1", sessionId: "s1", checkpointId: cp1.id, workspaceDir,
        scope: "all",
        sessionTranscriptPath: transcriptPath,
        onTranscriptRestored: async (newPath) => { restoredTranscriptPath = newPath; },
      });

      // Verify results
      expect(result.filesRestored).toBe(true);
      expect(result.transcriptRestored).toBe(true);
      expect(result.scope).toBe("all");

      // Files restored to cp1 state
      expect(await readFile("data.txt")).toBe("v1");

      // Transcript forked to new file with cp1 content + restore notice
      expect(restoredTranscriptPath).toBeDefined();
      const restoredContent = await fs.readFile(restoredTranscriptPath!, "utf8");
      expect(restoredContent).toContain(initialTranscript.trim());
      expect(restoredContent).toContain("custom_message");

      // Original transcript untouched
      const originalContent = await fs.readFile(transcriptPath, "utf8");
      expect(originalContent).toContain("step 3");

      // Manifest trimmed: only cp1 remains, cp2 is orphaned and deleted
      const manifestAfter = await store.getManifest("a1", "s1");
      expect(manifestAfter?.checkpoints).toEqual([cp1.id]);
      expect(manifestAfter?.currentHead).toBe(cp1.id);

      // cp2 metadata and snapshot are gone
      const cp2Meta = await store.getCheckpoint("a1", "s1", cp2.id);
      expect(cp2Meta).toBeNull();
    });
  });

  describe("getCheckpointDiff", () => {
    it("returns diff between checkpoint and its parent", async () => {
      await writeFile("a.txt", "v1");
      await engine.createCheckpoint({
        agentId: "a1",
        sessionId: "s1",
        runId: "r1",
        workspaceDir,
        trigger: { type: "manual" },
      });

      await writeFile("a.txt", "v2");
      await writeFile("b.txt", "new");
      const cp2 = await engine.createCheckpoint({
        agentId: "a1",
        sessionId: "s1",
        runId: "r1",
        workspaceDir,
        trigger: { type: "manual" },
      });

      const diff = await engine.getCheckpointDiff("a1", "s1", cp2.id);
      expect(diff).toContain("a.txt");
      expect(diff).toContain("b.txt");
    });
  });

  describe("deleteCheckpoint", () => {
    it("deletes a checkpoint and its snapshot", async () => {
      await writeFile("f.txt", "data");
      const cp = await engine.createCheckpoint({
        agentId: "a1",
        sessionId: "s1",
        runId: "r1",
        workspaceDir,
        trigger: { type: "manual" },
      });

      await engine.deleteCheckpoint("a1", "s1", cp.id);

      const remaining = await store.listCheckpoints("a1", "s1");
      expect(remaining.find((c) => c.id === cp.id)).toBeUndefined();
    });

    it("throws for nonexistent checkpoint", async () => {
      await expect(
        engine.deleteCheckpoint("a1", "s1", "nope"),
      ).rejects.toThrow("not found");
    });
  });

  describe("deleteSession", () => {
    it("deletes all checkpoints in a session", async () => {
      await writeFile("f.txt", "v1");
      await engine.createCheckpoint({
        agentId: "a1", sessionId: "s1", runId: "r1", workspaceDir,
        trigger: { type: "manual" },
      });
      await writeFile("f.txt", "v2");
      await engine.createCheckpoint({
        agentId: "a1", sessionId: "s1", runId: "r1", workspaceDir,
        trigger: { type: "manual" },
      });

      const deleted = await engine.deleteSession("a1", "s1");
      expect(deleted).toBe(2);

      const remaining = await store.listCheckpoints("a1", "s1");
      expect(remaining).toHaveLength(0);
    });

    it("returns 0 for empty session", async () => {
      const deleted = await engine.deleteSession("a1", "nonexistent");
      expect(deleted).toBe(0);
    });
  });

  describe("deleteBefore", () => {
    it("deletes checkpoints older than the cutoff date", async () => {
      await writeFile("f.txt", "data");
      const cp = await engine.createCheckpoint({
        agentId: "a1", sessionId: "s1", runId: "r1", workspaceDir,
        trigger: { type: "manual" },
      });

      // Backdate the checkpoint by writing meta.json directly (saveCheckpoint would duplicate manifest entry)
      const metaPath = path.join(tmpDir, "storage", "meta", "a1", "s1", cp.id, "meta.json");
      const oldMeta = JSON.parse(await fs.readFile(metaPath, "utf8"));
      oldMeta.createdAt = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      await fs.writeFile(metaPath, JSON.stringify(oldMeta, null, 2), "utf8");

      // Create a recent checkpoint
      await writeFile("f.txt", "data2");
      await engine.createCheckpoint({
        agentId: "a1", sessionId: "s1", runId: "r1", workspaceDir,
        trigger: { type: "manual" },
      });

      const deleted = await engine.deleteBefore(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000));
      expect(deleted).toBe(1);

      const remaining = await store.listCheckpoints("a1", "s1");
      expect(remaining).toHaveLength(1);
    });

    it("returns 0 when no checkpoints are older", async () => {
      await writeFile("f.txt", "data");
      await engine.createCheckpoint({
        agentId: "a1", sessionId: "s1", runId: "r1", workspaceDir,
        trigger: { type: "manual" },
      });

      const deleted = await engine.deleteBefore(new Date("2020-01-01"));
      expect(deleted).toBe(0);
    });
  });

  describe("pruneOld", () => {
    it("removes checkpoints older than retention period", async () => {
      await writeFile("f.txt", "data");
      const meta = await engine.createCheckpoint({
        agentId: "a1",
        sessionId: "s1",
        runId: "r1",
        workspaceDir,
        trigger: { type: "manual" },
      });

      // Backdate the checkpoint
      const oldMeta = await store.getCheckpoint("a1", "s1", meta.id);
      if (oldMeta) {
        const oldDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // 30 days ago
        oldMeta.createdAt = oldDate.toISOString();
        await store.saveCheckpoint(oldMeta);
      }

      const pruned = await engine.pruneOld();
      expect(pruned).toBeGreaterThanOrEqual(1);

      const remaining = await store.listCheckpoints("a1", "s1");
      expect(remaining.find((c) => c.id === meta.id)).toBeUndefined();
    });
  });
});
