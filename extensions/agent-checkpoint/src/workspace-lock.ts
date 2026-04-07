/**
 * Per-workspace async mutex.
 *
 * Serializes checkpoint create/restore operations on the same workspace
 * directory so that concurrent parent + sub-agent hooks don't corrupt
 * snapshots or manifests.
 */
export class WorkspaceLock {
  private readonly locks = new Map<string, Promise<void>>();

  async run<T>(workspaceDir: string, fn: () => Promise<T>): Promise<T> {
    const key = workspaceDir;

    // Wait for any in-flight operation on this workspace to finish
    while (this.locks.has(key)) {
      await this.locks.get(key);
    }

    let resolve!: () => void;
    const promise = new Promise<void>((r) => { resolve = r; });
    this.locks.set(key, promise);

    try {
      return await fn();
    } finally {
      this.locks.delete(key);
      resolve();
    }
  }
}
