import fs from "node:fs/promises";
import path from "node:path";
import type { PluginLogger } from "openclaw/plugin-sdk";
import type { SnapshotBackend, SnapshotResult } from "./snapshot-backend.js";

const DEFAULT_EXCLUDE = [".git", "node_modules", ".DS_Store"];

/**
 * Phase 1 snapshot backend: full directory copy via fs.cp.
 *
 * Snapshots are stored as:
 *   <storageDir>/snapshots/<checkpointId>/
 *
 * Atomicity: writes to a temp dir first, then renames.
 */
export class CopyBackend implements SnapshotBackend {
  readonly type = "copy";

  private readonly storageDir: string;
  private readonly excludePatterns: string[];
  private readonly logger?: PluginLogger;

  constructor(params: {
    storageDir: string;
    excludePatterns?: string[];
    logger?: PluginLogger;
  }) {
    this.storageDir = params.storageDir;
    this.excludePatterns = params.excludePatterns ?? DEFAULT_EXCLUDE;
    this.logger = params.logger;
  }

  async createSnapshot(params: {
    workspaceDir: string;
    checkpointId: string;
    parentRef?: string;
  }): Promise<SnapshotResult> {
    const { workspaceDir, checkpointId, parentRef } = params;

    await assertDirExists(workspaceDir);

    const snapshotDir = this.snapshotPath(checkpointId);
    const tmpDir = `${snapshotDir}.tmp-${Date.now()}`;

    await fs.mkdir(tmpDir, { recursive: true });
    try {
      await fs.cp(workspaceDir, tmpDir, {
        recursive: true,
        filter: this.createFilter(workspaceDir),
      });
      // Atomic rename
      await fs.rename(tmpDir, snapshotDir);
    } catch (error) {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      throw error;
    }

    // Compute changed files relative to parent
    const filesChanged = parentRef
      ? await this.computeChangedFiles(snapshotDir, this.snapshotPath(parentRef))
      : await this.listAllFiles(snapshotDir);

    const changeSummary = parentRef
      ? `${filesChanged.length} file(s) changed`
      : `${filesChanged.length} file(s) (initial)`;

    return { snapshotRef: checkpointId, filesChanged, changeSummary };
  }

  async restoreSnapshot(params: {
    workspaceDir: string;
    snapshotRef: string;
  }): Promise<void> {
    const { workspaceDir, snapshotRef } = params;
    const snapshotDir = this.snapshotPath(snapshotRef);

    await assertDirExists(snapshotDir);

    // Clear workspace contents (except excluded patterns)
    await this.clearDir(workspaceDir);

    // Copy snapshot back
    await fs.cp(snapshotDir, workspaceDir, {
      recursive: true,
    });
  }

  async diffSnapshot(params: {
    snapshotRef: string;
    parentRef?: string;
  }): Promise<string> {
    const { snapshotRef, parentRef } = params;
    const snapshotDir = this.snapshotPath(snapshotRef);

    if (!parentRef) {
      const files = await this.listAllFiles(snapshotDir);
      return files.length > 0
        ? `Files in snapshot:\n${files.map((f) => `  ${f}`).join("\n")}`
        : "Empty snapshot";
    }

    const parentDir = this.snapshotPath(parentRef);
    const changed = await this.computeChangedFiles(snapshotDir, parentDir);

    if (changed.length === 0) {
      return "No changes";
    }
    return `Changed files:\n${changed.map((f) => `  ${f}`).join("\n")}`;
  }

  async deleteSnapshot(snapshotRef: string): Promise<void> {
    const dir = this.snapshotPath(snapshotRef);
    await fs.rm(dir, { recursive: true, force: true });
  }

  // ── Internal ────────────────────────────────────────────────────────────

  private snapshotPath(checkpointId: string): string {
    return path.join(this.storageDir, "snapshots", checkpointId);
  }

  private createFilter(sourceRoot: string): (src: string) => boolean {
    return (src: string) => {
      const relative = path.relative(sourceRoot, src);
      if (relative === "") return true; // root itself
      const topSegment = relative.split(path.sep)[0]!;
      return !this.excludePatterns.includes(topSegment);
    };
  }

  /** Remove all contents of a directory except excluded patterns. */
  private async clearDir(dir: string): Promise<void> {
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      return;
    }

    for (const entry of entries) {
      if (this.excludePatterns.includes(entry)) continue;
      await fs.rm(path.join(dir, entry), { recursive: true, force: true });
    }
  }

  /** List all files in a directory recursively, returning relative paths. */
  private async listAllFiles(dir: string, prefix = ""): Promise<string[]> {
    const results: string[] = [];
    let entries: Awaited<ReturnType<typeof fs.readdir>>;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return results;
    }

    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        results.push(...(await this.listAllFiles(path.join(dir, entry.name), rel)));
      } else {
        results.push(rel);
      }
    }
    return results;
  }

  /** Compare two snapshot dirs, return list of files that differ. */
  private async computeChangedFiles(
    newDir: string,
    oldDir: string,
  ): Promise<string[]> {
    const newFiles = new Set(await this.listAllFiles(newDir));
    const oldFiles = new Set(await this.listAllFiles(oldDir));

    const changed: string[] = [];

    // Added or modified
    for (const file of newFiles) {
      if (!oldFiles.has(file)) {
        changed.push(file);
      } else {
        // Compare sizes as a fast heuristic
        try {
          const [newStat, oldStat] = await Promise.all([
            fs.stat(path.join(newDir, file)),
            fs.stat(path.join(oldDir, file)),
          ]);
          if (newStat.size !== oldStat.size || newStat.mtimeMs !== oldStat.mtimeMs) {
            changed.push(file);
          }
        } catch {
          changed.push(file);
        }
      }
    }

    // Removed
    for (const file of oldFiles) {
      if (!newFiles.has(file)) {
        changed.push(file);
      }
    }

    return changed.sort();
  }
}

async function assertDirExists(dir: string): Promise<void> {
  try {
    const stat = await fs.stat(dir);
    if (!stat.isDirectory()) {
      throw new Error(`Not a directory: ${dir}`);
    }
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new Error(`Directory does not exist: ${dir}`);
    }
    throw error;
  }
}
