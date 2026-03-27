import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { PluginLogger } from "../api.js";

const execFileAsync = promisify(execFile);

/** Maximum buffer for git command output. */
const MAX_BUFFER = 10 * 1024 * 1024;

export type GitSnapshotResult = {
  commitSha: string;
  treeSha: string;
  filesChanged: string[];
  diffStat: string;
};

export type GitRestoreResult = {
  restoredFiles: number;
};

/**
 * Git operations for checkpoint storage.
 *
 * Uses `git write-tree` + `git commit-tree` to create detached commit objects
 * without affecting HEAD or any branches. This is safe for concurrent use and
 * does not interfere with normal git workflow.
 */
export class GitBackend {
  private readonly workspaceDir: string;
  private readonly logger?: PluginLogger;

  constructor(params: { workspaceDir: string; logger?: PluginLogger }) {
    this.workspaceDir = params.workspaceDir;
    this.logger = params.logger;
  }

  /**
   * Check if the workspace is a git repository.
   */
  async isGitRepo(): Promise<boolean> {
    try {
      await this.git("rev-parse", "--git-dir");
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Initialize a git repo if one doesn't exist.
   */
  async ensureGitRepo(): Promise<void> {
    if (!(await this.isGitRepo())) {
      await this.git("init");
      // Create initial commit so we have a valid HEAD
      await this.git("commit", "--allow-empty", "-m", "checkpoint: initial");
    }
  }

  /**
   * Create a snapshot of the current workspace state as a detached git commit.
   *
   * Flow:
   * 1. `git add -A` to stage all changes
   * 2. `git write-tree` to create a tree object from the index
   * 3. `git commit-tree` to create a commit object (detached, no branch)
   * 4. `git reset` to unstage without affecting working tree
   * 5. Compute diff stats against parent
   */
  async createSnapshot(params: {
    checkpointId: string;
    parentCommitSha?: string;
    message?: string;
  }): Promise<GitSnapshotResult> {
    const { checkpointId, parentCommitSha, message } = params;
    const commitMessage = message ?? `checkpoint: ${checkpointId}`;

    // Stage all changes
    await this.git("add", "-A");

    // Create tree object from current index
    const treeSha = (await this.git("write-tree")).trim();

    // Create detached commit
    const commitArgs = ["commit-tree", treeSha, "-m", commitMessage];
    if (parentCommitSha) {
      commitArgs.push("-p", parentCommitSha);
    }
    const commitSha = (await this.git(...commitArgs)).trim();

    // Unstage to restore normal working state
    await this.git("reset").catch(() => {
      // reset may fail if there are no commits yet; safe to ignore
    });

    // Compute changed files relative to parent
    let filesChanged: string[] = [];
    let diffStat = "";
    if (parentCommitSha) {
      try {
        const diffOutput = await this.git(
          "diff-tree",
          "--no-commit-id",
          "--name-only",
          "-r",
          parentCommitSha,
          commitSha,
        );
        filesChanged = diffOutput
          .trim()
          .split("\n")
          .filter((line) => line.length > 0);

        const statOutput = await this.git("diff-tree", "--stat", parentCommitSha, commitSha);
        diffStat = statOutput.trim();
      } catch (error) {
        this.logger?.warn(`Failed to compute diff stats: ${String(error)}`);
      }
    } else {
      // First checkpoint: list all tracked files
      try {
        const lsOutput = await this.git("ls-tree", "-r", "--name-only", commitSha);
        filesChanged = lsOutput
          .trim()
          .split("\n")
          .filter((line) => line.length > 0);
        diffStat = `${filesChanged.length} files (initial checkpoint)`;
      } catch {
        // Ignore
      }
    }

    return { commitSha, treeSha, filesChanged, diffStat };
  }

  /**
   * Restore workspace files to the state captured in a checkpoint commit.
   */
  async restoreFiles(commitSha: string): Promise<GitRestoreResult> {
    // Read the checkpoint tree into the index
    await this.git("read-tree", commitSha);

    // Checkout all files from index to working tree
    await this.git("checkout-index", "-a", "-f");

    // Remove files not in the checkpoint
    const cleanOutput = await this.git("clean", "-fd");
    const restoredLines = cleanOutput
      .trim()
      .split("\n")
      .filter((l) => l.length > 0);

    // Reset index to HEAD to avoid leaving dirty state
    await this.git("reset").catch(() => {});

    return { restoredFiles: restoredLines.length };
  }

  /**
   * Get the diff between two checkpoint commits.
   */
  async getDiff(fromCommitSha: string, toCommitSha: string): Promise<string> {
    return await this.git("diff", fromCommitSha, toCommitSha);
  }

  /**
   * Get the diff for a single checkpoint relative to its parent.
   */
  async getCheckpointDiff(commitSha: string, parentCommitSha?: string): Promise<string> {
    if (!parentCommitSha) {
      // Show all files in the commit
      return await this.git("diff-tree", "-p", "--root", commitSha);
    }
    return await this.git("diff", parentCommitSha, commitSha);
  }

  /**
   * Get the current HEAD commit SHA, or null if no commits exist.
   */
  async getHeadCommit(): Promise<string | null> {
    try {
      const sha = (await this.git("rev-parse", "HEAD")).trim();
      return sha;
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private async git(...args: string[]): Promise<string> {
    const { stdout } = await execFileAsync("git", args, {
      cwd: this.workspaceDir,
      maxBuffer: MAX_BUFFER,
    });
    return stdout;
  }
}
