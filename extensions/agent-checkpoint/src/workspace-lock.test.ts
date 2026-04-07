import { describe, expect, it } from "vitest";
import { WorkspaceLock } from "./workspace-lock.js";

describe("WorkspaceLock", () => {
  it("serializes operations on the same workspace", async () => {
    const lock = new WorkspaceLock();
    const order: number[] = [];

    const op1 = lock.run("/workspace-a", async () => {
      await delay(50);
      order.push(1);
    });

    const op2 = lock.run("/workspace-a", async () => {
      order.push(2);
    });

    await Promise.all([op1, op2]);
    expect(order).toEqual([1, 2]); // op2 waits for op1
  });

  it("allows parallel operations on different workspaces", async () => {
    const lock = new WorkspaceLock();
    const order: string[] = [];

    const op1 = lock.run("/workspace-a", async () => {
      await delay(50);
      order.push("a");
    });

    const op2 = lock.run("/workspace-b", async () => {
      order.push("b");
    });

    await Promise.all([op1, op2]);
    expect(order).toEqual(["b", "a"]); // b finishes first (no delay)
  });

  it("releases lock on error", async () => {
    const lock = new WorkspaceLock();

    await expect(
      lock.run("/workspace-a", async () => { throw new Error("boom"); }),
    ).rejects.toThrow("boom");

    // Subsequent operation should not deadlock
    const result = await lock.run("/workspace-a", async () => "ok");
    expect(result).toBe("ok");
  });

  it("returns the function result", async () => {
    const lock = new WorkspaceLock();
    const result = await lock.run("/ws", async () => 42);
    expect(result).toBe(42);
  });
});

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
