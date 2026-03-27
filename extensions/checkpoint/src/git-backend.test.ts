import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitBackend } from "./git-backend.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

describe("GitBackend", () => {
  let tmpDir: string;
  let backend: GitBackend;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "git-backend-test-"));
    await git(tmpDir, "init");
    await git(tmpDir, "config", "user.email", "test@test.com");
    await git(tmpDir, "config", "user.name", "Test");
    // Create initial commit
    await fs.writeFile(path.join(tmpDir, "initial.txt"), "hello");
    await git(tmpDir, "add", "-A");
    await git(tmpDir, "commit", "-m", "initial");
    backend = new GitBackend({ workspaceDir: tmpDir });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("detects git repo", async () => {
    expect(await backend.isGitRepo()).toBe(true);
  });

  it("detects non-git directory", async () => {
    const nonGitDir = await fs.mkdtemp(path.join(os.tmpdir(), "non-git-"));
    const nonGitBackend = new GitBackend({ workspaceDir: nonGitDir });
    expect(await nonGitBackend.isGitRepo()).toBe(false);
    await fs.rm(nonGitDir, { recursive: true, force: true });
  });

  it("gets HEAD commit", async () => {
    const head = await backend.getHeadCommit();
    expect(head).toBeTruthy();
    expect(head!.length).toBe(40);
  });

  it("creates a snapshot with detached commit", async () => {
    // Modify a file
    await fs.writeFile(path.join(tmpDir, "new-file.ts"), "export const x = 1;");

    const head = await backend.getHeadCommit();
    const snapshot = await backend.createSnapshot({
      checkpointId: "ckpt-1",
      parentCommitSha: head!,
      message: "checkpoint: ckpt-1",
    });

    expect(snapshot.commitSha).toBeTruthy();
    expect(snapshot.commitSha.length).toBe(40);
    expect(snapshot.treeSha).toBeTruthy();
    expect(snapshot.filesChanged).toContain("new-file.ts");
    expect(snapshot.diffStat).toBeTruthy();

    // Verify the commit exists as a detached object (not on any branch)
    const commitType = await git(tmpDir, "cat-file", "-t", snapshot.commitSha);
    expect(commitType).toBe("commit");
  });

  it("creates first snapshot without parent", async () => {
    const snapshot = await backend.createSnapshot({
      checkpointId: "ckpt-initial",
    });

    expect(snapshot.commitSha).toBeTruthy();
    expect(snapshot.filesChanged).toContain("initial.txt");
  });

  it("creates chain of snapshots", async () => {
    await fs.writeFile(path.join(tmpDir, "a.txt"), "a");
    const snap1 = await backend.createSnapshot({
      checkpointId: "ckpt-1",
      parentCommitSha: (await backend.getHeadCommit())!,
    });

    await fs.writeFile(path.join(tmpDir, "b.txt"), "b");
    const snap2 = await backend.createSnapshot({
      checkpointId: "ckpt-2",
      parentCommitSha: snap1.commitSha,
    });

    expect(snap2.filesChanged).toContain("b.txt");
    // a.txt should not be in snap2's changed files since it was already in snap1
    expect(snap2.filesChanged).not.toContain("a.txt");
  });

  it("restores files from a checkpoint", async () => {
    // Create checkpoint with file
    await fs.writeFile(path.join(tmpDir, "restore-me.txt"), "original");
    const snap = await backend.createSnapshot({
      checkpointId: "ckpt-restore",
      parentCommitSha: (await backend.getHeadCommit())!,
    });

    // Modify the file
    await fs.writeFile(path.join(tmpDir, "restore-me.txt"), "modified");
    await fs.writeFile(path.join(tmpDir, "extra.txt"), "should-be-removed");

    // Restore
    await backend.restoreFiles(snap.commitSha);

    const content = await fs.readFile(path.join(tmpDir, "restore-me.txt"), "utf8");
    expect(content).toBe("original");
  });

  it("gets diff between checkpoints", async () => {
    await fs.writeFile(path.join(tmpDir, "diff-file.txt"), "version1");
    const snap1 = await backend.createSnapshot({
      checkpointId: "ckpt-d1",
      parentCommitSha: (await backend.getHeadCommit())!,
    });

    await fs.writeFile(path.join(tmpDir, "diff-file.txt"), "version2");
    const snap2 = await backend.createSnapshot({
      checkpointId: "ckpt-d2",
      parentCommitSha: snap1.commitSha,
    });

    const diff = await backend.getDiff(snap1.commitSha, snap2.commitSha);
    expect(diff).toContain("version1");
    expect(diff).toContain("version2");
  });
});
