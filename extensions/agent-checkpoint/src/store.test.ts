import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CheckpointStore } from "./store.js";
import type { CheckpointMeta } from "./types.js";

describe("CheckpointStore", () => {
  let tmpDir: string;
  let store: CheckpointStore;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cp-store-test-"));
    store = new CheckpointStore({ rootDir: tmpDir });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function makeMeta(overrides: Partial<CheckpointMeta> = {}): CheckpointMeta {
    return {
      id: overrides.id ?? "cp-test",
      parentId: overrides.parentId ?? null,
      sessionId: overrides.sessionId ?? "sess-1",
      agentId: overrides.agentId ?? "agent-1",
      runId: overrides.runId ?? "run-1",
      trigger: overrides.trigger ?? { type: "manual" },
      snapshot: overrides.snapshot ?? {
        backendType: "copy",
        snapshotRef: "cp-test",
        filesChanged: ["a.txt"],
        changeSummary: "1 file(s) (initial)",
      },
      transcript: overrides.transcript ?? { messageCount: 0, byteOffset: 0 },
      createdAt: overrides.createdAt ?? new Date().toISOString(),
      ...("toolDurationMs" in overrides ? { toolDurationMs: overrides.toolDurationMs } : {}),
      ...("toolResult" in overrides ? { toolResult: overrides.toolResult } : {}),
    };
  }

  describe("manifest", () => {
    it("returns null for nonexistent manifest", async () => {
      expect(await store.getManifest("agent-1", "sess-1")).toBeNull();
    });

    it("creates a manifest via getOrCreateManifest", async () => {
      const manifest = await store.getOrCreateManifest("agent-1", "sess-1");
      expect(manifest.agentId).toBe("agent-1");
      expect(manifest.sessionId).toBe("sess-1");
      expect(manifest.checkpoints).toEqual([]);
      expect(manifest.currentHead).toBeNull();
    });

    it("returns existing manifest on second call", async () => {
      await store.getOrCreateManifest("agent-1", "sess-1");
      const manifest = await store.getOrCreateManifest("agent-1", "sess-1");
      expect(manifest.checkpoints).toEqual([]);
    });
  });

  describe("saveCheckpoint / getCheckpoint", () => {
    it("saves and retrieves a checkpoint", async () => {
      const meta = makeMeta({ id: "cp-1" });
      await store.saveCheckpoint(meta);

      const retrieved = await store.getCheckpoint("agent-1", "sess-1", "cp-1");
      expect(retrieved).toEqual(meta);
    });

    it("updates manifest after save", async () => {
      await store.saveCheckpoint(makeMeta({ id: "cp-1" }));
      await store.saveCheckpoint(makeMeta({ id: "cp-2", parentId: "cp-1" }));

      const manifest = await store.getManifest("agent-1", "sess-1");
      expect(manifest?.checkpoints).toEqual(["cp-1", "cp-2"]);
      expect(manifest?.currentHead).toBe("cp-2");
    });

    it("returns null for nonexistent checkpoint", async () => {
      expect(await store.getCheckpoint("agent-1", "sess-1", "nope")).toBeNull();
    });
  });

  describe("listCheckpoints", () => {
    it("returns empty array for unknown session", async () => {
      expect(await store.listCheckpoints("agent-1", "sess-1")).toEqual([]);
    });

    it("returns all checkpoints in order", async () => {
      await store.saveCheckpoint(makeMeta({ id: "cp-a" }));
      await store.saveCheckpoint(makeMeta({ id: "cp-b", parentId: "cp-a" }));
      await store.saveCheckpoint(makeMeta({ id: "cp-c", parentId: "cp-b" }));

      const list = await store.listCheckpoints("agent-1", "sess-1");
      expect(list.map((c) => c.id)).toEqual(["cp-a", "cp-b", "cp-c"]);
    });
  });

  describe("deleteCheckpoint", () => {
    it("removes checkpoint and updates manifest", async () => {
      await store.saveCheckpoint(makeMeta({ id: "cp-1" }));
      await store.saveCheckpoint(makeMeta({ id: "cp-2", parentId: "cp-1" }));

      await store.deleteCheckpoint("agent-1", "sess-1", "cp-1");

      expect(await store.getCheckpoint("agent-1", "sess-1", "cp-1")).toBeNull();
      const manifest = await store.getManifest("agent-1", "sess-1");
      expect(manifest?.checkpoints).toEqual(["cp-2"]);
    });

    it("updates currentHead when deleting head", async () => {
      await store.saveCheckpoint(makeMeta({ id: "cp-1" }));
      await store.saveCheckpoint(makeMeta({ id: "cp-2", parentId: "cp-1" }));

      await store.deleteCheckpoint("agent-1", "sess-1", "cp-2");

      const manifest = await store.getManifest("agent-1", "sess-1");
      expect(manifest?.currentHead).toBe("cp-1");
    });

    it("is safe to delete from empty/nonexistent session", async () => {
      await expect(store.deleteCheckpoint("x", "y", "z")).resolves.toBeUndefined();
    });
  });

  describe("listSessions", () => {
    it("returns empty when no sessions exist", async () => {
      expect(await store.listSessions()).toEqual([]);
    });

    it("lists sessions across agents", async () => {
      await store.saveCheckpoint(makeMeta({ agentId: "a1", sessionId: "s1", id: "cp-1" }));
      await store.saveCheckpoint(makeMeta({ agentId: "a1", sessionId: "s2", id: "cp-2" }));
      await store.saveCheckpoint(makeMeta({ agentId: "a2", sessionId: "s3", id: "cp-3" }));

      const sessions = await store.listSessions();
      expect(sessions).toHaveLength(3);
      expect(sessions).toContainEqual(expect.objectContaining({ agentId: "a1", sessionId: "s1" }));
      expect(sessions).toContainEqual(expect.objectContaining({ agentId: "a1", sessionId: "s2" }));
      expect(sessions).toContainEqual(expect.objectContaining({ agentId: "a2", sessionId: "s3" }));
    });

    it("filters by agentId", async () => {
      await store.saveCheckpoint(makeMeta({ agentId: "a1", sessionId: "s1", id: "cp-1" }));
      await store.saveCheckpoint(makeMeta({ agentId: "a2", sessionId: "s2", id: "cp-2" }));

      const sessions = await store.listSessions("a1");
      expect(sessions).toEqual([expect.objectContaining({ agentId: "a1", sessionId: "s1" })]);
    });
  });
});
