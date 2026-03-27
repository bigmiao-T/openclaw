import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_CHECKPOINT_CONFIG, resolveCheckpointConfig } from "./config.js";

describe("resolveCheckpointConfig", () => {
  it("returns defaults for undefined config", () => {
    const result = resolveCheckpointConfig(undefined);
    expect(result).toEqual(DEFAULT_CHECKPOINT_CONFIG);
  });

  it("returns defaults for null config", () => {
    const result = resolveCheckpointConfig(null);
    expect(result).toEqual(DEFAULT_CHECKPOINT_CONFIG);
  });

  it("returns defaults for empty object", () => {
    const result = resolveCheckpointConfig({});
    expect(result).toEqual(DEFAULT_CHECKPOINT_CONFIG);
  });

  it("respects enabled: false", () => {
    const result = resolveCheckpointConfig({ enabled: false });
    expect(result.enabled).toBe(false);
  });

  it("resolves custom storagePath", () => {
    const result = resolveCheckpointConfig({ storagePath: "/mnt/nfs/checkpoints" });
    expect(result.storagePath).toBe("/mnt/nfs/checkpoints");
  });

  it("falls back to default storagePath for empty string", () => {
    const result = resolveCheckpointConfig({ storagePath: "" });
    expect(result.storagePath).toBe(path.join(os.homedir(), ".openclaw", "checkpoints"));
  });

  it("normalizes triggerOn", () => {
    expect(resolveCheckpointConfig({ triggerOn: "all_tools" }).triggerOn).toBe("all_tools");
    expect(resolveCheckpointConfig({ triggerOn: "manual" }).triggerOn).toBe("manual");
    expect(resolveCheckpointConfig({ triggerOn: "invalid" }).triggerOn).toBe("mutating_tools");
  });

  it("normalizes excludeTools", () => {
    const result = resolveCheckpointConfig({ excludeTools: ["custom_tool", "another"] });
    expect(result.excludeTools).toEqual(["custom_tool", "another"]);
  });

  it("uses default excludeTools for non-array", () => {
    const result = resolveCheckpointConfig({ excludeTools: "not-array" });
    expect(result.excludeTools).toEqual(DEFAULT_CHECKPOINT_CONFIG.excludeTools);
  });

  it("clamps maxCheckpointsPerSession", () => {
    expect(resolveCheckpointConfig({ maxCheckpointsPerSession: 0 }).maxCheckpointsPerSession).toBe(
      1,
    );
    expect(
      resolveCheckpointConfig({ maxCheckpointsPerSession: 2000 }).maxCheckpointsPerSession,
    ).toBe(1000);
    expect(resolveCheckpointConfig({ maxCheckpointsPerSession: 50 }).maxCheckpointsPerSession).toBe(
      50,
    );
  });

  it("clamps retentionDays", () => {
    expect(resolveCheckpointConfig({ retentionDays: 0 }).retentionDays).toBe(1);
    expect(resolveCheckpointConfig({ retentionDays: 500 }).retentionDays).toBe(365);
    expect(resolveCheckpointConfig({ retentionDays: 7 }).retentionDays).toBe(7);
  });

  it("normalizes restoreDefaultScope", () => {
    expect(resolveCheckpointConfig({ restoreDefaultScope: "files" }).restoreDefaultScope).toBe(
      "files",
    );
    expect(resolveCheckpointConfig({ restoreDefaultScope: "transcript" }).restoreDefaultScope).toBe(
      "transcript",
    );
    expect(resolveCheckpointConfig({ restoreDefaultScope: "invalid" }).restoreDefaultScope).toBe(
      "all",
    );
  });
});
