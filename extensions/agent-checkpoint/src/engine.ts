import fs from "node:fs/promises";
import { ulid } from "ulid";
import type { PluginLogger } from "openclaw/plugin-sdk";
import type { SnapshotBackend } from "./snapshot-backend.js";
import { CheckpointStore } from "./store.js";
import type {
  CheckpointMeta,
  CheckpointPluginConfig,
  CheckpointTrigger,
  RestoreScope,
} from "./types.js";

export type CreateCheckpointParams = {
  agentId: string;
  sessionId: string;
  runId: string;
  workspaceDir: string;
  trigger: CheckpointTrigger;
  toolDurationMs?: number;
  toolResult?: { success: boolean; errorMessage?: string };
  sessionTranscriptPath?: string;
};

export type RestoreCheckpointResult = {
  restoredCheckpoint: CheckpointMeta;
  scope: RestoreScope;
  filesRestored: boolean;
  transcriptRestored: boolean;
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

  async createCheckpoint(params: CreateCheckpointParams): Promise<CheckpointMeta> {
    const {
      agentId, sessionId, runId, workspaceDir, trigger,
      toolDurationMs, toolResult, sessionTranscriptPath,
    } = params;

    const checkpointId = ulid();
    const sessionKey = `${agentId}:${sessionId}`;

    // Resolve parent ref for diff computation
    let parentRef = this.lastRefBySession.get(sessionKey);
    if (!parentRef) {
      const manifest = await this.store.getManifest(agentId, sessionId);
      if (manifest?.currentHead) {
        const lastMeta = await this.store.getCheckpoint(agentId, sessionId, manifest.currentHead);
        if (lastMeta) parentRef = lastMeta.snapshot.snapshotRef;
      }
    }

    const snapshot = await this.backend.createSnapshot({
      workspaceDir,
      checkpointId,
      parentRef,
    });

    const transcript = await getTranscriptState(sessionTranscriptPath);

    const parentId = await this.getCurrentHead(agentId, sessionId);

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
      toolDurationMs,
      toolResult,
    };

    await this.store.saveCheckpoint(meta);
    this.lastRefBySession.set(sessionKey, snapshot.snapshotRef);

    await this.store.pruneExcessWithBackend(
      agentId, sessionId, this.config.maxCheckpointsPerSession, this.backend,
    );

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
      if (sessionTranscriptPath && meta.transcript.byteOffset > 0) {
        await truncateFile(sessionTranscriptPath, meta.transcript.byteOffset);
        transcriptRestored = true;
      }
    }

    // Trim manifest to restored point
    const manifest = await this.store.getOrCreateManifest(agentId, sessionId);
    manifest.currentHead = checkpointId;
    const idx = manifest.checkpoints.indexOf(checkpointId);
    if (idx >= 0) manifest.checkpoints = manifest.checkpoints.slice(0, idx + 1);
    await this.store.writeManifest(agentId, sessionId, manifest);

    this.logger?.info(
      `Restored to ${checkpointId} (scope: ${scope}, files: ${filesRestored}, transcript: ${transcriptRestored})`,
    );

    return { restoredCheckpoint: meta, scope, filesRestored, transcriptRestored };
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

  async pruneOld(): Promise<number> {
    return await this.store.pruneOldWithBackend(this.config.retentionDays, this.backend);
  }

  private async getCurrentHead(agentId: string, sessionId: string): Promise<string | null> {
    const manifest = await this.store.getManifest(agentId, sessionId);
    return manifest?.currentHead ?? null;
  }
}

async function getTranscriptState(
  transcriptPath?: string,
): Promise<{ messageCount: number; byteOffset: number }> {
  if (!transcriptPath) return { messageCount: 0, byteOffset: 0 };
  try {
    const stat = await fs.stat(transcriptPath);
    const content = await fs.readFile(transcriptPath, "utf8");
    const messageCount = content.split("\n").filter((l) => l.trim().length > 0).length;
    return { messageCount, byteOffset: stat.size };
  } catch {
    return { messageCount: 0, byteOffset: 0 };
  }
}

async function truncateFile(filePath: string, byteOffset: number): Promise<void> {
  const handle = await fs.open(filePath, "r+");
  try {
    await handle.truncate(byteOffset);
  } finally {
    await handle.close();
  }
}
