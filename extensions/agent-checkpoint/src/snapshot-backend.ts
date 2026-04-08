import type { PluginLogger } from "openclaw/plugin-sdk";
import { CopyBackend } from "./copy-backend.js";

// ─── Snapshot result ────────────────────────────────────────────────────────

export interface SnapshotResult {
  /** Opaque reference the backend uses to identify this snapshot. */
  snapshotRef: string;
  /** Files changed relative to parentRef (empty if unknown or first snapshot). */
  filesChanged: string[];
  /** Human-readable summary of changes. */
  changeSummary?: string;
}

// ─── Backend interface ──────────────────────────────────────────────────────

export interface SnapshotBackend {
  readonly type: string;

  /**
   * Capture the current state of workspaceDir as a snapshot.
   * Throws if workspaceDir does not exist.
   */
  createSnapshot(params: {
    workspaceDir: string;
    checkpointId: string;
    parentRef?: string;
  }): Promise<SnapshotResult>;

  /**
   * Restore workspaceDir to the state captured in snapshotRef.
   * Throws if snapshotRef does not exist.
   */
  restoreSnapshot(params: {
    workspaceDir: string;
    snapshotRef: string;
  }): Promise<void>;

  /**
   * Return a human-readable diff between a snapshot and its parent.
   * If parentRef is absent, returns the snapshot's full file listing.
   */
  diffSnapshot(params: {
    snapshotRef: string;
    parentRef?: string;
  }): Promise<string>;

  /**
   * Delete snapshot data. Idempotent: no error if snapshotRef does not exist.
   */
  deleteSnapshot(snapshotRef: string): Promise<void>;

  /**
   * Return the filesystem directory where a snapshot's data is stored.
   * Used by engine for co-located data (e.g. task flow DB backups).
   */
  getSnapshotDir(snapshotRef: string): string;

  init?(): Promise<void>;
  dispose?(): Promise<void>;
}

// ─── Factory ────────────────────────────────────────────────────────────────

export type BackendType = "copy";

export function createSnapshotBackend(params: {
  type: BackendType;
  storageDir: string;
  backendConfig: Record<string, unknown>;
  logger?: PluginLogger;
}): SnapshotBackend {
  switch (params.type) {
    case "copy": {
      const excludePatterns = Array.isArray(params.backendConfig.excludePatterns)
        ? (params.backendConfig.excludePatterns as string[])
        : undefined;
      return new CopyBackend({
        storageDir: params.storageDir,
        excludePatterns,
        logger: params.logger,
      });
    }
    default:
      throw new Error(`Unknown snapshot backend type: ${params.type}`);
  }
}
