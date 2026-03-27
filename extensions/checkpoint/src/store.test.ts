import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CheckpointStore } from "./store.js";
import type { CheckpointMeta } from "./types.js";

function makeMeta(overrides: Partial<CheckpointMeta> = {}): CheckpointMeta {
  return {
    id: overrides.id ?? "ckpt-1",
    parentId: overrides.parentId ?? null,
    sessionId: overrides.sessionId ?? "session-1",
    agentId: overrides.agentId ?? "agent-1",
    runId: overrides.runId ?? "run-1",
    trigger: overrides.trigger ?? { type: "after_tool_call", toolName: "edit" },
    git: overrides.git ?? {
      commitSha: "abc123",
      treeSha: "def456",
      filesChanged: ["file.ts"],
      diffStat: "1 file changed",
    },
    transcript: overrides.transcript ?? { messageCount: 5, byteOffset: 1024 },
    createdAt: overrides.createdAt ?? new Date().toISOString(),
    toolDurationMs: overrides.toolDurationMs,
    toolResult: overrides.toolResult,
  };
}

describe("CheckpointStore", () => {
  let tmpDir: string;
  let store: CheckpointStore;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ckpt-store-test-"));
    store = new CheckpointStore({ rootDir: tmpDir });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe("manifest operations", () => {
    it("returns null for non-existent manifest", async () => {
      const manifest = await store.getManifest("agent-1", "session-1");
      expect(manifest).toBeNull();
    });

    it("creates manifest on getOrCreate", async () => {
      const manifest = await store.getOrCreateManifest("agent-1", "session-1");
      expect(manifest.sessionId).toBe("session-1");
      expect(manifest.agentId).toBe("agent-1");
      expect(manifest.checkpoints).toEqual([]);
      expect(manifest.currentHead).toBeNull();
    });

    it("returns existing manifest on second getOrCreate", async () => {
      const first = await store.getOrCreateManifest("agent-1", "session-1");
      first.checkpoints.push("ckpt-1");
      await store.writeManifest("agent-1", "session-1", first);

      const second = await store.getOrCreateManifest("agent-1", "session-1");
      expect(second.checkpoints).toEqual(["ckpt-1"]);
    });
  });

  describe("checkpoint CRUD", () => {
    it("saves and retrieves a checkpoint", async () => {
      const meta = makeMeta();
      await store.saveCheckpoint(meta);

      const retrieved = await store.getCheckpoint("agent-1", "session-1", "ckpt-1");
      expect(retrieved).not.toBeNull();
      expect(retrieved!.id).toBe("ckpt-1");
      expect(retrieved!.trigger.toolName).toBe("edit");
    });

    it("updates manifest when saving checkpoint", async () => {
      await store.saveCheckpoint(makeMeta({ id: "ckpt-1" }));
      await store.saveCheckpoint(makeMeta({ id: "ckpt-2" }));

      const manifest = await store.getManifest("agent-1", "session-1");
      expect(manifest!.checkpoints).toEqual(["ckpt-1", "ckpt-2"]);
      expect(manifest!.currentHead).toBe("ckpt-2");
    });

    it("lists all checkpoints for a session", async () => {
      await store.saveCheckpoint(makeMeta({ id: "ckpt-1" }));
      await store.saveCheckpoint(makeMeta({ id: "ckpt-2" }));

      const list = await store.listCheckpoints("agent-1", "session-1");
      expect(list).toHaveLength(2);
      expect(list.map((c) => c.id)).toEqual(["ckpt-1", "ckpt-2"]);
    });

    it("returns empty list for non-existent session", async () => {
      const list = await store.listCheckpoints("agent-1", "no-session");
      expect(list).toEqual([]);
    });

    it("deletes a checkpoint", async () => {
      await store.saveCheckpoint(makeMeta({ id: "ckpt-1" }));
      await store.saveCheckpoint(makeMeta({ id: "ckpt-2" }));

      await store.deleteCheckpoint("agent-1", "session-1", "ckpt-1");

      const list = await store.listCheckpoints("agent-1", "session-1");
      expect(list).toHaveLength(1);
      expect(list[0]!.id).toBe("ckpt-2");

      const manifest = await store.getManifest("agent-1", "session-1");
      expect(manifest!.checkpoints).toEqual(["ckpt-2"]);
    });

    it("updates currentHead when deleting the head checkpoint", async () => {
      await store.saveCheckpoint(makeMeta({ id: "ckpt-1" }));
      await store.saveCheckpoint(makeMeta({ id: "ckpt-2" }));

      await store.deleteCheckpoint("agent-1", "session-1", "ckpt-2");

      const manifest = await store.getManifest("agent-1", "session-1");
      expect(manifest!.currentHead).toBe("ckpt-1");
    });
  });

  describe("session listing", () => {
    it("lists sessions across agents", async () => {
      await store.saveCheckpoint(makeMeta({ agentId: "agent-1", sessionId: "s1" }));
      await store.saveCheckpoint(makeMeta({ agentId: "agent-2", sessionId: "s2" }));

      const sessions = await store.listSessions();
      expect(sessions).toHaveLength(2);
      expect(sessions).toContainEqual({ agentId: "agent-1", sessionId: "s1" });
      expect(sessions).toContainEqual({ agentId: "agent-2", sessionId: "s2" });
    });

    it("filters by agentId", async () => {
      await store.saveCheckpoint(makeMeta({ agentId: "agent-1", sessionId: "s1" }));
      await store.saveCheckpoint(makeMeta({ agentId: "agent-2", sessionId: "s2" }));

      const sessions = await store.listSessions("agent-1");
      expect(sessions).toHaveLength(1);
      expect(sessions[0]).toEqual({ agentId: "agent-1", sessionId: "s1" });
    });
  });

  describe("pruning", () => {
    it("prunes excess checkpoints", async () => {
      for (let i = 1; i <= 5; i++) {
        await store.saveCheckpoint(makeMeta({ id: `ckpt-${i}` }));
      }

      const pruned = await store.pruneExcessCheckpoints("agent-1", "session-1", 3);
      expect(pruned).toBe(2);

      const remaining = await store.listCheckpoints("agent-1", "session-1");
      expect(remaining).toHaveLength(3);
      expect(remaining.map((c) => c.id)).toEqual(["ckpt-3", "ckpt-4", "ckpt-5"]);
    });

    it("prunes old checkpoints by retention days", async () => {
      const oldDate = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
      const newDate = new Date().toISOString();

      await store.saveCheckpoint(makeMeta({ id: "old-1", createdAt: oldDate }));
      await store.saveCheckpoint(makeMeta({ id: "new-1", createdAt: newDate }));

      const pruned = await store.pruneOldCheckpoints(30);
      expect(pruned).toBe(1);

      const remaining = await store.listCheckpoints("agent-1", "session-1");
      expect(remaining).toHaveLength(1);
      expect(remaining[0]!.id).toBe("new-1");
    });
  });
});
