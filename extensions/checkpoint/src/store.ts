import fs from "node:fs/promises";
import path from "node:path";
import type { PluginLogger } from "../api.js";
import type { CheckpointId, CheckpointManifest, CheckpointMeta } from "./types.js";

/**
 * Filesystem-backed checkpoint metadata store.
 *
 * Directory layout:
 *   <rootDir>/<agentId>/<sessionId>/manifest.json
 *   <rootDir>/<agentId>/<sessionId>/<checkpointId>/meta.json
 */
export class CheckpointStore {
  private readonly rootDir: string;
  private readonly logger?: PluginLogger;

  constructor(params: { rootDir: string; logger?: PluginLogger }) {
    this.rootDir = path.resolve(params.rootDir);
    this.logger = params.logger;
  }

  // ---------------------------------------------------------------------------
  // Manifest operations
  // ---------------------------------------------------------------------------

  async getManifest(agentId: string, sessionId: string): Promise<CheckpointManifest | null> {
    const manifestPath = this.manifestPath(agentId, sessionId);
    return await this.readJson<CheckpointManifest>(manifestPath);
  }

  async getOrCreateManifest(agentId: string, sessionId: string): Promise<CheckpointManifest> {
    const existing = await this.getManifest(agentId, sessionId);
    if (existing) {
      return existing;
    }
    const manifest: CheckpointManifest = {
      sessionId,
      agentId,
      checkpoints: [],
      currentHead: null,
    };
    await this.writeManifest(agentId, sessionId, manifest);
    return manifest;
  }

  async writeManifest(
    agentId: string,
    sessionId: string,
    manifest: CheckpointManifest,
  ): Promise<void> {
    const manifestPath = this.manifestPath(agentId, sessionId);
    await this.writeJson(manifestPath, manifest);
  }

  // ---------------------------------------------------------------------------
  // Checkpoint metadata operations
  // ---------------------------------------------------------------------------

  async saveCheckpoint(meta: CheckpointMeta): Promise<void> {
    const checkpointDir = this.checkpointDir(meta.agentId, meta.sessionId, meta.id);
    await fs.mkdir(checkpointDir, { recursive: true });
    const metaPath = path.join(checkpointDir, "meta.json");
    await this.writeJson(metaPath, meta);

    // Update manifest
    const manifest = await this.getOrCreateManifest(meta.agentId, meta.sessionId);
    manifest.checkpoints.push(meta.id);
    manifest.currentHead = meta.id;
    await this.writeManifest(meta.agentId, meta.sessionId, manifest);
  }

  async getCheckpoint(
    agentId: string,
    sessionId: string,
    checkpointId: CheckpointId,
  ): Promise<CheckpointMeta | null> {
    const metaPath = path.join(this.checkpointDir(agentId, sessionId, checkpointId), "meta.json");
    return await this.readJson<CheckpointMeta>(metaPath);
  }

  async listCheckpoints(agentId: string, sessionId: string): Promise<CheckpointMeta[]> {
    const manifest = await this.getManifest(agentId, sessionId);
    if (!manifest) {
      return [];
    }

    const results: CheckpointMeta[] = [];
    for (const checkpointId of manifest.checkpoints) {
      const meta = await this.getCheckpoint(agentId, sessionId, checkpointId);
      if (meta) {
        results.push(meta);
      }
    }
    return results;
  }

  async deleteCheckpoint(
    agentId: string,
    sessionId: string,
    checkpointId: CheckpointId,
  ): Promise<void> {
    const dir = this.checkpointDir(agentId, sessionId, checkpointId);
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});

    // Update manifest
    const manifest = await this.getManifest(agentId, sessionId);
    if (manifest) {
      manifest.checkpoints = manifest.checkpoints.filter((id) => id !== checkpointId);
      if (manifest.currentHead === checkpointId) {
        manifest.currentHead =
          manifest.checkpoints.length > 0
            ? manifest.checkpoints[manifest.checkpoints.length - 1]!
            : null;
      }
      await this.writeManifest(agentId, sessionId, manifest);
    }
  }

  // ---------------------------------------------------------------------------
  // Session listing
  // ---------------------------------------------------------------------------

  async listSessions(agentId?: string): Promise<Array<{ agentId: string; sessionId: string }>> {
    const results: Array<{ agentId: string; sessionId: string }> = [];

    try {
      const agentIds = agentId
        ? [agentId]
        : (await fs.readdir(this.rootDir, { withFileTypes: true }))
            .filter((d) => d.isDirectory())
            .map((d) => d.name);

      for (const aid of agentIds) {
        const agentDir = path.join(this.rootDir, aid);
        try {
          const sessionDirs = await fs.readdir(agentDir, { withFileTypes: true });
          for (const sd of sessionDirs) {
            if (sd.isDirectory()) {
              results.push({ agentId: aid, sessionId: sd.name });
            }
          }
        } catch {
          // Agent dir may not exist
        }
      }
    } catch {
      // Root dir may not exist
    }

    return results;
  }

  // ---------------------------------------------------------------------------
  // Pruning
  // ---------------------------------------------------------------------------

  async pruneOldCheckpoints(retentionDays: number): Promise<number> {
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    let pruned = 0;

    const sessions = await this.listSessions();
    for (const { agentId, sessionId } of sessions) {
      const checkpoints = await this.listCheckpoints(agentId, sessionId);
      for (const meta of checkpoints) {
        const createdAt = Date.parse(meta.createdAt);
        if (Number.isFinite(createdAt) && createdAt < cutoff) {
          await this.deleteCheckpoint(agentId, sessionId, meta.id);
          pruned++;
        }
      }
    }

    return pruned;
  }

  async pruneExcessCheckpoints(
    agentId: string,
    sessionId: string,
    maxCheckpoints: number,
  ): Promise<number> {
    const manifest = await this.getManifest(agentId, sessionId);
    if (!manifest || manifest.checkpoints.length <= maxCheckpoints) {
      return 0;
    }

    const excess = manifest.checkpoints.length - maxCheckpoints;
    const toRemove = manifest.checkpoints.slice(0, excess);
    let pruned = 0;

    for (const checkpointId of toRemove) {
      await this.deleteCheckpoint(agentId, sessionId, checkpointId);
      pruned++;
    }

    return pruned;
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private manifestPath(agentId: string, sessionId: string): string {
    return path.join(this.rootDir, agentId, sessionId, "manifest.json");
  }

  private checkpointDir(agentId: string, sessionId: string, checkpointId: string): string {
    return path.join(this.rootDir, agentId, sessionId, checkpointId);
  }

  private async writeJson(filePath: string, data: unknown): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf8");
  }

  private async readJson<T>(filePath: string): Promise<T | null> {
    try {
      const raw = await fs.readFile(filePath, "utf8");
      return JSON.parse(raw) as T;
    } catch (error) {
      if (isFileNotFound(error)) {
        return null;
      }
      this.logger?.warn(`Failed to read checkpoint metadata at ${filePath}: ${String(error)}`);
      return null;
    }
  }
}

function isFileNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
