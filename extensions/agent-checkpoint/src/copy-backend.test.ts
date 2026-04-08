import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CopyBackend } from "./copy-backend.js";

describe("CopyBackend", () => {
  let tmpDir: string;
  let workspaceDir: string;
  let storageDir: string;
  let backend: CopyBackend;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cp-backend-test-"));
    workspaceDir = path.join(tmpDir, "workspace");
    storageDir = path.join(tmpDir, "storage");
    await fs.mkdir(workspaceDir, { recursive: true });

    backend = new CopyBackend({ storageDir, excludePatterns: [".git", "node_modules"] });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function writeFile(rel: string, content: string) {
    const full = path.join(workspaceDir, rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content, "utf8");
  }

  async function readFile(rel: string): Promise<string> {
    return fs.readFile(path.join(workspaceDir, rel), "utf8");
  }

  async function fileExists(rel: string): Promise<boolean> {
    try {
      await fs.access(path.join(workspaceDir, rel));
      return true;
    } catch {
      return false;
    }
  }

  describe("createSnapshot", () => {
    it("creates a snapshot of the workspace", async () => {
      await writeFile("hello.txt", "world");
      await writeFile("src/main.ts", "console.log('hi')");

      const result = await backend.createSnapshot({
        workspaceDir,
        checkpointId: "cp-001",
      });

      expect(result.snapshotRef).toBe("copy:cp-001");
      expect(result.filesChanged).toContain("hello.txt");
      expect(result.filesChanged).toContain("src/main.ts");
      expect(result.changeSummary).toContain("initial");
    });

    it("excludes patterns from snapshot", async () => {
      await writeFile("app.ts", "code");
      await fs.mkdir(path.join(workspaceDir, ".git"), { recursive: true });
      await fs.writeFile(path.join(workspaceDir, ".git", "HEAD"), "ref: refs/heads/main");
      await fs.mkdir(path.join(workspaceDir, "node_modules", "pkg"), { recursive: true });
      await fs.writeFile(path.join(workspaceDir, "node_modules", "pkg", "index.js"), "module");

      const result = await backend.createSnapshot({
        workspaceDir,
        checkpointId: "cp-002",
      });

      expect(result.filesChanged).toContain("app.ts");
      expect(result.filesChanged).not.toContain(".git/HEAD");
      expect(result.filesChanged).not.toContain("node_modules/pkg/index.js");

      // Verify snapshot directory doesn't contain excluded dirs
      const snapshotDir = path.join(storageDir, "snapshots", "cp-002");
      const entries = await fs.readdir(snapshotDir);
      expect(entries).toContain("app.ts");
      expect(entries).not.toContain(".git");
      expect(entries).not.toContain("node_modules");
    });

    it("computes changed files relative to parent", async () => {
      await writeFile("a.txt", "v1");
      await writeFile("b.txt", "v1");
      await backend.createSnapshot({ workspaceDir, checkpointId: "cp-base" });

      // Modify one file, add another
      await writeFile("a.txt", "v2");
      await writeFile("c.txt", "new");

      const result = await backend.createSnapshot({
        workspaceDir,
        checkpointId: "cp-next",
        parentRef: "cp-base",
      });

      expect(result.filesChanged).toContain("a.txt");
      expect(result.filesChanged).toContain("c.txt");
      expect(result.changeSummary).toMatch(/changed/);
    });

    it("throws when workspace does not exist", async () => {
      await expect(
        backend.createSnapshot({
          workspaceDir: path.join(tmpDir, "nonexistent"),
          checkpointId: "cp-bad",
        }),
      ).rejects.toThrow("does not exist");
    });
  });

  describe("restoreSnapshot", () => {
    it("restores workspace to snapshot state", async () => {
      await writeFile("a.txt", "original");
      await writeFile("b.txt", "keep");
      await backend.createSnapshot({ workspaceDir, checkpointId: "cp-restore" });

      // Modify workspace
      await writeFile("a.txt", "modified");
      await writeFile("c.txt", "new file");
      await fs.rm(path.join(workspaceDir, "b.txt"));

      // Restore
      await backend.restoreSnapshot({ workspaceDir, snapshotRef: "cp-restore" });

      expect(await readFile("a.txt")).toBe("original");
      expect(await readFile("b.txt")).toBe("keep");
      expect(await fileExists("c.txt")).toBe(false);
    });

    it("preserves excluded directories during restore", async () => {
      await writeFile("code.ts", "v1");
      await backend.createSnapshot({ workspaceDir, checkpointId: "cp-excl" });

      // Add .git and node_modules after snapshot
      await fs.mkdir(path.join(workspaceDir, ".git"), { recursive: true });
      await fs.writeFile(path.join(workspaceDir, ".git", "config"), "git config");

      await backend.restoreSnapshot({ workspaceDir, snapshotRef: "cp-excl" });

      // .git should survive the restore
      expect(await fileExists(".git/config")).toBe(true);
      expect(await readFile("code.ts")).toBe("v1");
    });

    it("throws when snapshot does not exist", async () => {
      await expect(
        backend.restoreSnapshot({ workspaceDir, snapshotRef: "nonexistent" }),
      ).rejects.toThrow("does not exist");
    });
  });

  describe("diffSnapshot", () => {
    it("returns file list for snapshot without parent", async () => {
      await writeFile("x.ts", "code");
      await backend.createSnapshot({ workspaceDir, checkpointId: "cp-diff1" });

      const diff = await backend.diffSnapshot({ snapshotRef: "cp-diff1" });
      expect(diff).toContain("x.ts");
    });

    it("returns changed files between two snapshots", async () => {
      await writeFile("stable.txt", "same");
      await writeFile("changed.txt", "v1");
      await backend.createSnapshot({ workspaceDir, checkpointId: "cp-diffA" });

      await writeFile("changed.txt", "v2");
      await backend.createSnapshot({ workspaceDir, checkpointId: "cp-diffB" });

      const diff = await backend.diffSnapshot({ snapshotRef: "cp-diffB", parentRef: "cp-diffA" });
      expect(diff).toContain("changed.txt");
    });
  });

  describe("deleteSnapshot", () => {
    it("removes the snapshot directory", async () => {
      await writeFile("f.txt", "data");
      await backend.createSnapshot({ workspaceDir, checkpointId: "cp-del" });

      const snapshotDir = path.join(storageDir, "snapshots", "cp-del");
      expect(await dirExists(snapshotDir)).toBe(true);

      await backend.deleteSnapshot("cp-del");
      expect(await dirExists(snapshotDir)).toBe(false);
    });

    it("is idempotent for nonexistent snapshots", async () => {
      await expect(backend.deleteSnapshot("never-existed")).resolves.toBeUndefined();
    });
  });
});

async function dirExists(dir: string): Promise<boolean> {
  try {
    const stat = await fs.stat(dir);
    return stat.isDirectory();
  } catch {
    return false;
  }
}
