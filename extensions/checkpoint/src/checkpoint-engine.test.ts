import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CheckpointEngine } from "./checkpoint-engine.js";
import { DEFAULT_CHECKPOINT_CONFIG } from "./config.js";
import { CheckpointStore } from "./store.js";
import type { CheckpointPluginConfig } from "./types.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

describe("CheckpointEngine", () => {
  let tmpDir: string;
  let storeDir: string;
  let workspaceDir: string;
  let store: CheckpointStore;
  let engine: CheckpointEngine;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ckpt-engine-test-"));
    storeDir = path.join(tmpDir, "store");
    workspaceDir = path.join(tmpDir, "workspace");
    await fs.mkdir(storeDir, { recursive: true });
    await fs.mkdir(workspaceDir, { recursive: true });

    // Init git repo
    await git(workspaceDir, "init");
    await git(workspaceDir, "config", "user.email", "test@test.com");
    await git(workspaceDir, "config", "user.name", "Test");
    await fs.writeFile(path.join(workspaceDir, "initial.txt"), "hello");
    await git(workspaceDir, "add", "-A");
    await git(workspaceDir, "commit", "-m", "initial");

    store = new CheckpointStore({ rootDir: storeDir });
    const config: CheckpointPluginConfig = {
      ...DEFAULT_CHECKPOINT_CONFIG,
      storagePath: storeDir,
    };
    engine = new CheckpointEngine({ store, config });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe("shouldCreateCheckpoint", () => {
    it("returns true for mutating tools", () => {
      expect(engine.shouldCreateCheckpoint("edit")).toBe(true);
      expect(engine.shouldCreateCheckpoint("write")).toBe(true);
      expect(engine.shouldCreateCheckpoint("bash")).toBe(true);
    });

    it("returns false for excluded tools", () => {
      expect(engine.shouldCreateCheckpoint("read")).toBe(false);
      expect(engine.shouldCreateCheckpoint("glob")).toBe(false);
      expect(engine.shouldCreateCheckpoint("grep")).toBe(false);
      expect(engine.shouldCreateCheckpoint("memory_search")).toBe(false);
    });

    it("is case-insensitive", () => {
      expect(engine.shouldCreateCheckpoint("Read")).toBe(false);
      expect(engine.shouldCreateCheckpoint("GLOB")).toBe(false);
    });
  });

  describe("createCheckpoint", () => {
    it("creates a checkpoint with metadata", async () => {
      await fs.writeFile(path.join(workspaceDir, "new.ts"), "export const x = 1;");

      const meta = await engine.createCheckpoint({
        agentId: "agent-1",
        sessionId: "session-1",
        runId: "run-1",
        workspaceDir,
        trigger: { type: "after_tool_call", toolName: "edit" },
        toolDurationMs: 150,
        toolResult: { success: true },
      });

      expect(meta.id).toBeTruthy();
      expect(meta.agentId).toBe("agent-1");
      expect(meta.sessionId).toBe("session-1");
      expect(meta.git.commitSha).toBeTruthy();
      expect(meta.git.filesChanged).toContain("new.ts");
      expect(meta.toolDurationMs).toBe(150);
      expect(meta.toolResult!.success).toBe(true);
    });

    it("creates a chain of checkpoints", async () => {
      await fs.writeFile(path.join(workspaceDir, "a.ts"), "a");
      const ckpt1 = await engine.createCheckpoint({
        agentId: "agent-1",
        sessionId: "session-1",
        runId: "run-1",
        workspaceDir,
        trigger: { type: "after_tool_call", toolName: "write" },
      });

      await fs.writeFile(path.join(workspaceDir, "b.ts"), "b");
      const ckpt2 = await engine.createCheckpoint({
        agentId: "agent-1",
        sessionId: "session-1",
        runId: "run-1",
        workspaceDir,
        trigger: { type: "after_tool_call", toolName: "write" },
      });

      expect(ckpt2.parentId).toBe(ckpt1.id);

      const list = await engine.listCheckpoints("agent-1", "session-1");
      expect(list).toHaveLength(2);
    });
  });

  describe("restoreCheckpoint", () => {
    it("restores files to checkpoint state", async () => {
      await fs.writeFile(path.join(workspaceDir, "file.ts"), "original");
      const ckpt = await engine.createCheckpoint({
        agentId: "agent-1",
        sessionId: "session-1",
        runId: "run-1",
        workspaceDir,
        trigger: { type: "after_tool_call", toolName: "write" },
      });

      // Modify file
      await fs.writeFile(path.join(workspaceDir, "file.ts"), "modified");

      const result = await engine.restoreCheckpoint({
        agentId: "agent-1",
        sessionId: "session-1",
        checkpointId: ckpt.id,
        workspaceDir,
        scope: "files",
      });

      expect(result.filesRestored).toBe(true);
      expect(result.transcriptRestored).toBe(false);

      const content = await fs.readFile(path.join(workspaceDir, "file.ts"), "utf8");
      expect(content).toBe("original");
    });

    it("restores transcript when scope includes transcript", async () => {
      const transcriptPath = path.join(tmpDir, "transcript.jsonl");
      await fs.writeFile(transcriptPath, '{"msg":"hello"}\n');

      const ckpt = await engine.createCheckpoint({
        agentId: "agent-1",
        sessionId: "session-1",
        runId: "run-1",
        workspaceDir,
        trigger: { type: "session_start" },
        sessionTranscriptPath: transcriptPath,
      });

      // Add more to transcript
      await fs.appendFile(transcriptPath, '{"msg":"world"}\n{"msg":"extra"}\n');

      await engine.restoreCheckpoint({
        agentId: "agent-1",
        sessionId: "session-1",
        checkpointId: ckpt.id,
        workspaceDir,
        scope: "transcript",
        sessionTranscriptPath: transcriptPath,
      });

      const content = await fs.readFile(transcriptPath, "utf8");
      expect(content).toBe('{"msg":"hello"}\n');
    });

    it("throws for non-existent checkpoint", async () => {
      await expect(
        engine.restoreCheckpoint({
          agentId: "agent-1",
          sessionId: "session-1",
          checkpointId: "non-existent",
          workspaceDir,
        }),
      ).rejects.toThrow("Checkpoint not found");
    });

    it("truncates checkpoint chain on restore", async () => {
      const ckpt1 = await engine.createCheckpoint({
        agentId: "agent-1",
        sessionId: "session-1",
        runId: "run-1",
        workspaceDir,
        trigger: { type: "session_start" },
      });

      await fs.writeFile(path.join(workspaceDir, "file.ts"), "data");
      await engine.createCheckpoint({
        agentId: "agent-1",
        sessionId: "session-1",
        runId: "run-1",
        workspaceDir,
        trigger: { type: "after_tool_call", toolName: "write" },
      });

      await engine.restoreCheckpoint({
        agentId: "agent-1",
        sessionId: "session-1",
        checkpointId: ckpt1.id,
        workspaceDir,
        scope: "files",
      });

      const list = await engine.listCheckpoints("agent-1", "session-1");
      expect(list).toHaveLength(1);
      expect(list[0]!.id).toBe(ckpt1.id);
    });
  });
});
