import fs from "node:fs/promises";
import path from "node:path";
import type { PluginLogger } from "openclaw/plugin-sdk";
import type { CheckpointId, CheckpointManifest, CheckpointMeta } from "./types.js";

/**
 * Filesystem-backed checkpoint metadata store.
 *
 * Layout:
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

  // ── Manifest ────────────────────────────────────────────────────────────

  async getManifest(agentId: string, sessionId: string): Promise<CheckpointManifest | null> {
    return await this.readJson<CheckpointManifest>(this.manifestPath(agentId, sessionId));
  }

  async getOrCreateManifest(agentId: string, sessionId: string): Promise<CheckpointManifest> {
    const existing = await this.getManifest(agentId, sessionId);
    if (existing) return existing;

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
    await this.writeJson(this.manifestPath(agentId, sessionId), manifest);
  }

  // ── Checkpoint CRUD ─────────────────────────────────────────────────────

  async saveCheckpoint(meta: CheckpointMeta): Promise<void> {
    const dir = this.checkpointDir(meta.agentId, meta.sessionId, meta.id);
    await fs.mkdir(dir, { recursive: true });
    await this.writeJson(path.join(dir, "meta.json"), meta);

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
    return await this.readJson<CheckpointMeta>(
      path.join(this.checkpointDir(agentId, sessionId, checkpointId), "meta.json"),
    );
  }

  async listCheckpoints(agentId: string, sessionId: string): Promise<CheckpointMeta[]> {
    const manifest = await this.getManifest(agentId, sessionId);
    if (!manifest) return [];

    const results: CheckpointMeta[] = [];
    for (const id of manifest.checkpoints) {
      const meta = await this.getCheckpoint(agentId, sessionId, id);
      if (meta) results.push(meta);
    }
    return results;
  }

  async deleteCheckpoint(
    agentId: string,
    sessionId: string,
    checkpointId: CheckpointId,
  ): Promise<void> {
    await fs.rm(this.checkpointDir(agentId, sessionId, checkpointId), {
      recursive: true,
      force: true,
    });

    const manifest = await this.getManifest(agentId, sessionId);
    if (manifest) {
      manifest.checkpoints = manifest.checkpoints.filter((id) => id !== checkpointId);
      if (manifest.currentHead === checkpointId) {
        manifest.currentHead = manifest.checkpoints.at(-1) ?? null;
      }
      await this.writeManifest(agentId, sessionId, manifest);
    }
  }

  /** Remove the entire session directory (manifest + all checkpoint metadata). */
  async deleteSessionDir(agentId: string, sessionId: string): Promise<void> {
    const sessionDir = path.join(this.rootDir, agentId, sessionId);
    await fs.rm(sessionDir, { recursive: true, force: true });
  }

  // ── Queries ─────────────────────────────────────────────────────────────

  async listSessions(
    agentId?: string,
  ): Promise<Array<{
    agentId: string;
    sessionId: string;
    checkpointCount: number;
    parentSession: import("./types.js").SessionRef | null;
    childSessions: import("./types.js").SessionRef[];
  }>> {
    const results: Array<{
      agentId: string;
      sessionId: string;
      checkpointCount: number;
      parentSession: import("./types.js").SessionRef | null;
      childSessions: import("./types.js").SessionRef[];
    }> = [];
    try {
      const agentIds = agentId
        ? [agentId]
        : (await fs.readdir(this.rootDir, { withFileTypes: true }))
            .filter((d) => d.isDirectory())
            .map((d) => d.name);

      for (const aid of agentIds) {
        try {
          const sessions = await fs.readdir(path.join(this.rootDir, aid), { withFileTypes: true });
          for (const sd of sessions) {
            if (!sd.isDirectory()) continue;
            const manifest = await this.getManifest(aid, sd.name);
            results.push({
              agentId: aid,
              sessionId: sd.name,
              checkpointCount: manifest?.checkpoints?.length ?? 0,
              parentSession: manifest?.parentSession ?? null,
              childSessions: manifest?.childSessions ?? [],
            });
          }
        } catch {
          /* agent dir may not exist */
        }
      }
    } catch {
      /* root dir may not exist */
    }
    return results;
  }

  /**
   * Search across all sessions for a checkpoint by ID.
   * Returns the resolved agentId, sessionId, and metadata, or null if not found.
   */
  async findCheckpoint(
    checkpointId: string,
  ): Promise<{ agentId: string; sessionId: string; meta: CheckpointMeta } | null> {
    for (const { agentId, sessionId } of await this.listSessions()) {
      const meta = await this.getCheckpoint(agentId, sessionId, checkpointId);
      if (meta) return { agentId, sessionId, meta };
    }
    return null;
  }

  // ── Internal ────────────────────────────────────────────────────────────

  private manifestPath(agentId: string, sessionId: string): string {
    return path.join(this.rootDir, agentId, sessionId, "manifest.json");
  }

  private checkpointDir(agentId: string, sessionId: string, checkpointId: string): string {
    return path.join(this.rootDir, agentId, sessionId, checkpointId);
  }

  private async writeJson(filePath: string, data: unknown): Promise<void> {
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });
    // Atomic write: write to temp file then rename to avoid corruption on concurrent access
    const tmpPath = `${filePath}.tmp-${Date.now()}`;
    await fs.writeFile(tmpPath, JSON.stringify(data, null, 2), "utf8");
    await fs.rename(tmpPath, filePath);
  }

  private async readJson<T>(filePath: string): Promise<T | null> {
    try {
      return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
      this.logger?.warn(`Failed to read ${filePath}: ${String(error)}`);
      return null;
    }
  }
}
