import fs from "node:fs/promises";
import path from "node:path";
import type { PluginLogger } from "openclaw/plugin-sdk";
import type { SnapshotBackend } from "./snapshot-backend.js";
import { CheckpointStore } from "./store.js";
import type {
  CheckpointMeta,
  CheckpointPluginConfig,
  CheckpointTrigger,
  RestoreScope,
  SessionRef,
} from "./types.js";

export type CreateCheckpointParams = {
  agentId: string;
  sessionId: string;
  runId: string;
  workspaceDir: string;
  trigger: CheckpointTrigger;
  sessionTranscriptPath?: string;
};

export type RestoreCheckpointResult = {
  restoredCheckpoint: CheckpointMeta;
  scope: RestoreScope;
  filesRestored: boolean;
  transcriptRestored: boolean;
  /** Diff of changes that were undone (empty string if unavailable). */
  diff: string;
};

/**
 * Orchestrates snapshot backend + metadata store for checkpoint operations.
 *
 * Only operations that need coordination live here.
 * Pure queries (list, get) go through store directly.
 */
export class CheckpointEngine {
  readonly store: CheckpointStore;
  private readonly backend: SnapshotBackend;
  private readonly config: CheckpointPluginConfig;
  private readonly logger?: PluginLogger;

  /** Tracks last snapshotRef per session for parent chain. */
  private readonly lastRefBySession = new Map<string, string>();
  constructor(params: {
    store: CheckpointStore;
    backend: SnapshotBackend;
    config: CheckpointPluginConfig;
    logger?: PluginLogger;
  }) {
    this.store = params.store;
    this.backend = params.backend;
    this.config = params.config;
    this.logger = params.logger;
  }

  shouldCreateCheckpoint(toolName: string): boolean {
    if (this.config.triggerOn === "manual") return false;
    const normalized = toolName.trim().toLowerCase();
    return !this.config.excludeTools.some((t) => t.toLowerCase() === normalized);
  }

  async createCheckpoint(params: CreateCheckpointParams): Promise<CheckpointMeta | null> {
    const {
      agentId, sessionId, runId, workspaceDir, trigger, sessionTranscriptPath,
    } = params;

    const sessionKey = `${agentId}:${sessionId}`;

    // Resolve parent ref for diff computation + sequence number
    let parentRef = this.lastRefBySession.get(sessionKey);
    const manifest = await this.store.getOrCreateManifest(agentId, sessionId);
    if (!parentRef && manifest.currentHead) {
      const lastMeta = await this.store.getCheckpoint(agentId, sessionId, manifest.currentHead);
      if (lastMeta) parentRef = lastMeta.snapshot.snapshotRef;
    }

    const seq = manifest.checkpoints.length + 1;
    const checkpointId = buildCheckpointId(agentId, sessionId, seq, trigger);

    const snapshot = await this.backend.createSnapshot({
      workspaceDir,
      checkpointId,
      parentRef,
    });

    // Skip checkpoints with no file changes (auto-triggered only; manual and session_start always kept)
    if (snapshot.filesChanged.length === 0 && trigger.type === "after_tool_call") {
      await this.backend.deleteSnapshot(snapshot.snapshotRef);
      this.logger?.info(`Skipped checkpoint ${checkpointId} — no files changed`);
      return null;
    }

    const snapshotDir = this.backend.getSnapshotDir(snapshot.snapshotRef);
    const transcript = await captureTranscriptSnapshot(sessionTranscriptPath, snapshotDir);

    const parentId = manifest.currentHead;

    const meta: CheckpointMeta = {
      id: checkpointId,
      parentId,
      sessionId,
      agentId,
      runId,
      trigger,
      snapshot: {
        backendType: this.backend.type,
        snapshotRef: snapshot.snapshotRef,
        filesChanged: snapshot.filesChanged,
        changeSummary: snapshot.changeSummary,
      },
      transcript,
      createdAt: new Date().toISOString(),
    };

    await this.store.saveCheckpoint(meta);
    this.lastRefBySession.set(sessionKey, snapshot.snapshotRef);

    const toolDesc = trigger.toolName ? ` after ${trigger.toolName}` : "";
    this.logger?.info(
      `Checkpoint ${checkpointId} created${toolDesc} (${snapshot.filesChanged.length} files changed)`,
    );

    return meta;
  }

  async restoreCheckpoint(params: {
    agentId: string;
    sessionId: string;
    checkpointId: string;
    workspaceDir: string;
    scope?: RestoreScope;
    sessionTranscriptPath?: string;
    /**
     * Called after a transcript snapshot is restored to a new file.
     * The callback should update the session store to point to the new transcript file,
     * following the same pattern as core compaction checkpoint restore.
     */
    onTranscriptRestored?: (newTranscriptPath: string) => Promise<void>;
  }): Promise<RestoreCheckpointResult> {
    const { agentId, sessionId, checkpointId, workspaceDir, sessionTranscriptPath } = params;
    const scope = params.scope ?? this.config.restoreDefaultScope;

    const meta = await this.store.getCheckpoint(agentId, sessionId, checkpointId);
    if (!meta) throw new Error(`Checkpoint not found: ${checkpointId}`);

    let filesRestored = false;
    let transcriptRestored = false;

    if (scope === "files" || scope === "all") {
      await this.backend.restoreSnapshot({
        workspaceDir,
        snapshotRef: meta.snapshot.snapshotRef,
      });
      filesRestored = true;
      this.lastRefBySession.set(`${agentId}:${sessionId}`, meta.snapshot.snapshotRef);
    }

    if (scope === "transcript" || scope === "all") {
      if (sessionTranscriptPath && meta.transcript.snapshotFile) {
        // Fork: copy snapshot to a new file in the sessions directory (same as core compaction restore).
        // This avoids overwriting the live session file and lets the session store pointer switch atomically.
        const sessionsDir = path.dirname(sessionTranscriptPath);
        const newFileName = `${path.basename(sessionTranscriptPath, ".jsonl")}.restored-${Date.now()}.jsonl`;
        const newTranscriptPath = path.join(sessionsDir, newFileName);
        await fs.copyFile(meta.transcript.snapshotFile, newTranscriptPath);

        // Append a restore notice so the dashboard shows it after refresh
        const notice = JSON.stringify({
          type: "custom_message",
          customType: "Checkpoint Restore",
          content: `Rolled back to checkpoint \`${checkpointId}\`. Conversation history has been restored to this point.`,
          display: true,
          timestamp: new Date().toISOString(),
        });
        await fs.appendFile(newTranscriptPath, "\n" + notice + "\n");

        if (params.onTranscriptRestored) {
          // Caller updates the session store to point to the new file
          await params.onTranscriptRestored(newTranscriptPath);
        }
        transcriptRestored = true;
      }
    }

    // Trim manifest to restored point and clean up orphaned snapshots/metadata
    const manifest = await this.store.getOrCreateManifest(agentId, sessionId);
    const idx = manifest.checkpoints.indexOf(checkpointId);
    if (idx >= 0) {
      const orphaned = manifest.checkpoints.slice(idx + 1);
      for (const orphanId of orphaned) {
        const orphanMeta = await this.store.getCheckpoint(agentId, sessionId, orphanId);
        if (orphanMeta) await this.backend.deleteSnapshot(orphanMeta.snapshot.snapshotRef);
        await this.store.deleteCheckpoint(agentId, sessionId, orphanId);
      }
    }
    manifest.currentHead = checkpointId;
    manifest.checkpoints = manifest.checkpoints.slice(0, idx >= 0 ? idx + 1 : undefined);
    await this.store.writeManifest(agentId, sessionId, manifest);

    // Compute diff of changes that were undone
    let diff = "";
    try {
      diff = await this.getCheckpointDiff(agentId, sessionId, checkpointId);
    } catch {
      // Diff is best-effort; don't fail restore if it's unavailable
    }

    this.logger?.info(
      `Restored to ${checkpointId} (scope: ${scope}, files: ${filesRestored}, transcript: ${transcriptRestored})`,
    );

    return { restoredCheckpoint: meta, scope, filesRestored, transcriptRestored, diff };
  }

  async getCheckpointDiff(
    agentId: string,
    sessionId: string,
    checkpointId: string,
  ): Promise<string> {
    const meta = await this.store.getCheckpoint(agentId, sessionId, checkpointId);
    if (!meta) throw new Error(`Checkpoint not found: ${checkpointId}`);

    let parentRef: string | undefined;
    if (meta.parentId) {
      const parentMeta = await this.store.getCheckpoint(agentId, sessionId, meta.parentId);
      if (parentMeta) parentRef = parentMeta.snapshot.snapshotRef;
    }

    return await this.backend.diffSnapshot({
      snapshotRef: meta.snapshot.snapshotRef,
      parentRef,
    });
  }

  /**
   * Link parent and child session manifests bidirectionally.
   * Called from the subagent_spawned hook.
   */
  async linkParentChild(parentRef: SessionRef, childRef: SessionRef): Promise<void> {
    // Set parentSession on child manifest
    const childManifest = await this.store.getOrCreateManifest(childRef.agentId, childRef.sessionId);
    childManifest.parentSession = parentRef;
    await this.store.writeManifest(childRef.agentId, childRef.sessionId, childManifest);

    // Append to childSessions on parent manifest
    const parentManifest = await this.store.getOrCreateManifest(parentRef.agentId, parentRef.sessionId);
    const children = parentManifest.childSessions ?? [];
    if (!children.some((c) => c.sessionId === childRef.sessionId && c.agentId === childRef.agentId)) {
      children.push(childRef);
      parentManifest.childSessions = children;
      await this.store.writeManifest(parentRef.agentId, parentRef.sessionId, parentManifest);
    }

    this.logger?.info(
      `Linked parent ${parentRef.agentId}/${parentRef.sessionId} ↔ child ${childRef.agentId}/${childRef.sessionId}`,
    );
  }

  async deleteCheckpoint(agentId: string, sessionId: string, checkpointId: string): Promise<void> {
    const meta = await this.store.getCheckpoint(agentId, sessionId, checkpointId);
    if (!meta) throw new Error(`Checkpoint not found: ${checkpointId}`);
    await this.backend.deleteSnapshot(meta.snapshot.snapshotRef);
    await this.store.deleteCheckpoint(agentId, sessionId, checkpointId);
    this.logger?.info(`Deleted checkpoint ${checkpointId}`);
  }

  async deleteSession(agentId: string, sessionId: string): Promise<number> {
    const checkpoints = await this.store.listCheckpoints(agentId, sessionId);
    for (const meta of checkpoints) {
      await this.backend.deleteSnapshot(meta.snapshot.snapshotRef);
    }
    await this.store.deleteSessionDir(agentId, sessionId);
    this.logger?.info(`Deleted session ${agentId}/${sessionId} (${checkpoints.length} checkpoints)`);
    return checkpoints.length;
  }

  async deleteAll(): Promise<number> {
    let deleted = 0;
    for (const { agentId, sessionId } of await this.store.listSessions()) {
      deleted += await this.deleteSession(agentId, sessionId);
    }
    this.logger?.info(`Deleted all checkpoints (${deleted} total)`);
    return deleted;
  }

  async deleteBefore(cutoffDate: Date): Promise<number> {
    const cutoff = cutoffDate.getTime();
    let deleted = 0;

    for (const { agentId, sessionId } of await this.store.listSessions()) {
      for (const meta of await this.store.listCheckpoints(agentId, sessionId)) {
        const createdAt = Date.parse(meta.createdAt);
        if (Number.isFinite(createdAt) && createdAt < cutoff) {
          await this.backend.deleteSnapshot(meta.snapshot.snapshotRef);
          await this.store.deleteCheckpoint(agentId, sessionId, meta.id);
          deleted++;
        }
      }
    }
    this.logger?.info(`Deleted ${deleted} checkpoints before ${cutoffDate.toISOString()}`);
    return deleted;
  }

  async pruneOld(): Promise<number> {
    const cutoff = Date.now() - this.config.retentionDays * 24 * 60 * 60 * 1000;
    let pruned = 0;

    for (const { agentId, sessionId } of await this.store.listSessions()) {
      for (const meta of await this.store.listCheckpoints(agentId, sessionId)) {
        const createdAt = Date.parse(meta.createdAt);
        if (Number.isFinite(createdAt) && createdAt < cutoff) {
          await this.backend.deleteSnapshot(meta.snapshot.snapshotRef);
          await this.store.deleteCheckpoint(agentId, sessionId, meta.id);
          pruned++;
        }
      }
    }
    return pruned;
  }

  async pruneExcess(agentId: string, sessionId: string): Promise<number> {
    const manifest = await this.store.getManifest(agentId, sessionId);
    if (!manifest || manifest.checkpoints.length <= this.config.maxCheckpointsPerSession) return 0;

    const excess = manifest.checkpoints.length - this.config.maxCheckpointsPerSession;
    const toRemove = manifest.checkpoints.slice(0, excess);
    let pruned = 0;

    for (const id of toRemove) {
      const meta = await this.store.getCheckpoint(agentId, sessionId, id);
      if (meta) await this.backend.deleteSnapshot(meta.snapshot.snapshotRef);
      await this.store.deleteCheckpoint(agentId, sessionId, id);
      pruned++;
    }
    return pruned;
  }

}

/**
 * Capture transcript state by copying the session JSONL file into the snapshot directory.
 * Follows the same approach as core compaction checkpoints: a full copy ensures
 * restore works even if the original file is rewritten by compaction.
 */
async function captureTranscriptSnapshot(
  transcriptPath: string | undefined,
  snapshotDir: string,
): Promise<{ messageCount: number; snapshotFile?: string }> {
  if (!transcriptPath) return { messageCount: 0 };
  try {
    const content = await fs.readFile(transcriptPath, "utf8");
    const messageCount = content.split("\n").filter((l) => l.trim().length > 0).length;

    // Copy entire transcript into the snapshot directory
    const snapshotFile = path.join(snapshotDir, "transcript.jsonl");
    await fs.copyFile(transcriptPath, snapshotFile);

    return { messageCount, snapshotFile };
  } catch {
    return { messageCount: 0 };
  }
}

/**
 * Build a human-readable checkpoint ID.
 * Format: {agent}-{session_prefix}-{seq:03d}-{trigger_abbr}-{ts}
 * Example: main-a1b2c3-001-exec-1775754159, main-a1b2c3-002-start-1775754200
 * The timestamp suffix ensures uniqueness even when seq resets after restore.
 */
function buildCheckpointId(
  agentId: string,
  sessionId: string,
  seq: number,
  trigger: CheckpointTrigger,
): string {
  const agent = agentId.slice(0, 12);
  const session = sessionId.slice(0, 6);
  const seqStr = String(seq).padStart(3, "0");
  const triggerAbbr = triggerToAbbr(trigger);
  const ts = Math.floor(Date.now() / 1000);
  return `${agent}-${session}-${seqStr}-${triggerAbbr}-${ts}`;
}

function triggerToAbbr(trigger: CheckpointTrigger): string {
  switch (trigger.type) {
    case "session_start":
      return "start";
    case "manual":
      return "manual";
    case "after_tool_call":
      return trigger.toolName
        ? trigger.toolName.slice(0, 16).toLowerCase().replace(/[^a-z0-9]/g, "-")
        : "tool";
  }
}
