import fs from "node:fs/promises";
import { ulid } from "ulid";
import type { PluginLogger } from "../api.js";
import { GitBackend } from "./git-backend.js";
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
  /** Path to the session JSONL file for transcript offset tracking. */
  sessionTranscriptPath?: string;
};

export type RestoreCheckpointParams = {
  agentId: string;
  sessionId: string;
  checkpointId: string;
  workspaceDir: string;
  scope?: RestoreScope;
  /** Path to the session JSONL file for transcript rollback. */
  sessionTranscriptPath?: string;
};

export type RestoreCheckpointResult = {
  restoredCheckpoint: CheckpointMeta;
  scope: RestoreScope;
  filesRestored: boolean;
  transcriptRestored: boolean;
};

/**
 * Orchestrates checkpoint creation, restoration, listing, and pruning.
 */
export class CheckpointEngine {
  private readonly store: CheckpointStore;
  private readonly config: CheckpointPluginConfig;
  private readonly logger?: PluginLogger;

  /** Tracks the last checkpoint commit SHA per session for parent chain. */
  private readonly lastCommitBySession = new Map<string, string>();

  constructor(params: {
    store: CheckpointStore;
    config: CheckpointPluginConfig;
    logger?: PluginLogger;
  }) {
    this.store = params.store;
    this.config = params.config;
    this.logger = params.logger;
  }

  /**
   * Determine whether a tool call should trigger a checkpoint.
   */
  shouldCreateCheckpoint(toolName: string): boolean {
    if (this.config.triggerOn === "manual") {
      return false;
    }

    const normalizedTool = toolName.trim().toLowerCase();

    if (this.config.excludeTools.some((t) => t.toLowerCase() === normalizedTool)) {
      return false;
    }

    return true;
  }

  /**
   * Create a checkpoint capturing the current workspace state.
   */
  async createCheckpoint(params: CreateCheckpointParams): Promise<CheckpointMeta> {
    const {
      agentId,
      sessionId,
      runId,
      workspaceDir,
      trigger,
      toolDurationMs,
      toolResult,
      sessionTranscriptPath,
    } = params;

    const git = new GitBackend({ workspaceDir, logger: this.logger });
    await git.ensureGitRepo();

    const checkpointId = ulid();
    const sessionKey = `${agentId}:${sessionId}`;

    // Determine parent commit for the chain
    let parentCommitSha = this.lastCommitBySession.get(sessionKey);
    if (!parentCommitSha) {
      // Check manifest for last checkpoint
      const manifest = await this.store.getManifest(agentId, sessionId);
      if (manifest?.currentHead) {
        const lastMeta = await this.store.getCheckpoint(agentId, sessionId, manifest.currentHead);
        if (lastMeta) {
          parentCommitSha = lastMeta.git.commitSha;
        }
      }
    }
    if (!parentCommitSha) {
      parentCommitSha = (await git.getHeadCommit()) ?? undefined;
    }

    // Create git snapshot
    const toolDesc = trigger.toolName ? ` after ${trigger.toolName}` : "";
    const snapshot = await git.createSnapshot({
      checkpointId,
      parentCommitSha,
      message: `checkpoint: ${checkpointId}${toolDesc}`,
    });

    // Track transcript position
    const transcript = await getTranscriptState(sessionTranscriptPath);

    const meta: CheckpointMeta = {
      id: checkpointId,
      parentId: this.lastCommitBySession.has(sessionKey)
        ? await this.getLastCheckpointId(agentId, sessionId)
        : null,
      sessionId,
      agentId,
      runId,
      trigger,
      git: {
        commitSha: snapshot.commitSha,
        treeSha: snapshot.treeSha,
        filesChanged: snapshot.filesChanged,
        diffStat: snapshot.diffStat,
      },
      transcript,
      createdAt: new Date().toISOString(),
      toolDurationMs,
      toolResult,
    };

    await this.store.saveCheckpoint(meta);
    this.lastCommitBySession.set(sessionKey, snapshot.commitSha);

    // Prune if over limit
    await this.store.pruneExcessCheckpoints(
      agentId,
      sessionId,
      this.config.maxCheckpointsPerSession,
    );

    this.logger?.info(
      `Checkpoint ${checkpointId} created${toolDesc} (${snapshot.filesChanged.length} files changed)`,
    );

    return meta;
  }

  /**
   * Restore workspace to a previous checkpoint.
   */
  async restoreCheckpoint(params: RestoreCheckpointParams): Promise<RestoreCheckpointResult> {
    const { agentId, sessionId, checkpointId, workspaceDir, sessionTranscriptPath } = params;
    const scope = params.scope ?? this.config.restoreDefaultScope;

    const meta = await this.store.getCheckpoint(agentId, sessionId, checkpointId);
    if (!meta) {
      throw new Error(`Checkpoint not found: ${checkpointId}`);
    }

    let filesRestored = false;
    let transcriptRestored = false;

    // Restore files
    if (scope === "files" || scope === "all") {
      const git = new GitBackend({ workspaceDir, logger: this.logger });
      await git.restoreFiles(meta.git.commitSha);
      filesRestored = true;

      // Update the commit chain to point to restored checkpoint
      const sessionKey = `${agentId}:${sessionId}`;
      this.lastCommitBySession.set(sessionKey, meta.git.commitSha);
    }

    // Restore transcript
    if (scope === "transcript" || scope === "all") {
      if (sessionTranscriptPath && meta.transcript.byteOffset > 0) {
        await truncateFile(sessionTranscriptPath, meta.transcript.byteOffset);
        transcriptRestored = true;
      }
    }

    // Update manifest head
    const manifest = await this.store.getOrCreateManifest(agentId, sessionId);
    manifest.currentHead = checkpointId;
    // Remove checkpoints after the restored one
    const restoreIndex = manifest.checkpoints.indexOf(checkpointId);
    if (restoreIndex >= 0) {
      manifest.checkpoints = manifest.checkpoints.slice(0, restoreIndex + 1);
    }
    await this.store.writeManifest(agentId, sessionId, manifest);

    this.logger?.info(
      `Restored to checkpoint ${checkpointId} (scope: ${scope}, files: ${filesRestored}, transcript: ${transcriptRestored})`,
    );

    return {
      restoredCheckpoint: meta,
      scope,
      filesRestored,
      transcriptRestored,
    };
  }

  /**
   * List all checkpoints for a session.
   */
  async listCheckpoints(agentId: string, sessionId: string): Promise<CheckpointMeta[]> {
    return await this.store.listCheckpoints(agentId, sessionId);
  }

  /**
   * List all sessions that have checkpoints.
   */
  async listSessions(agentId?: string): Promise<Array<{ agentId: string; sessionId: string }>> {
    return await this.store.listSessions(agentId);
  }

  /**
   * Get diff for a specific checkpoint.
   */
  async getCheckpointDiff(
    agentId: string,
    sessionId: string,
    checkpointId: string,
    workspaceDir: string,
  ): Promise<string> {
    const meta = await this.store.getCheckpoint(agentId, sessionId, checkpointId);
    if (!meta) {
      throw new Error(`Checkpoint not found: ${checkpointId}`);
    }

    const git = new GitBackend({ workspaceDir, logger: this.logger });

    // Find parent checkpoint for diff
    let parentCommitSha: string | undefined;
    if (meta.parentId) {
      const parentMeta = await this.store.getCheckpoint(agentId, sessionId, meta.parentId);
      if (parentMeta) {
        parentCommitSha = parentMeta.git.commitSha;
      }
    }

    return await git.getCheckpointDiff(meta.git.commitSha, parentCommitSha);
  }

  /**
   * Prune old checkpoints across all sessions.
   */
  async pruneOld(): Promise<number> {
    return await this.store.pruneOldCheckpoints(this.config.retentionDays);
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private async getLastCheckpointId(agentId: string, sessionId: string): Promise<string | null> {
    const manifest = await this.store.getManifest(agentId, sessionId);
    return manifest?.currentHead ?? null;
  }
}

async function getTranscriptState(
  transcriptPath?: string,
): Promise<{ messageCount: number; byteOffset: number }> {
  if (!transcriptPath) {
    return { messageCount: 0, byteOffset: 0 };
  }

  try {
    const stat = await fs.stat(transcriptPath);
    const byteOffset = stat.size;

    // Count lines (each JSONL line = 1 message entry)
    const content = await fs.readFile(transcriptPath, "utf8");
    const messageCount = content.split("\n").filter((line) => line.trim().length > 0).length;

    return { messageCount, byteOffset };
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
