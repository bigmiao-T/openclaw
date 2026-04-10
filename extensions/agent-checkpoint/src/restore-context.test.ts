import { describe, expect, it } from "vitest";
import { buildContinuationContext } from "./restore-context.js";
import type { CheckpointMeta } from "./types.js";

function makeCheckpointMeta(overrides?: Partial<CheckpointMeta>): CheckpointMeta {
  return {
    id: "main-abc123-003-bash",
    parentId: "main-abc123-002-exec",
    sessionId: "abc123",
    agentId: "main",
    runId: "run-1",
    trigger: { type: "after_tool_call", toolName: "Bash" },
    snapshot: {
      backendType: "copy",
      snapshotRef: "copy:main-abc123-003-bash",
      filesChanged: ["src/index.ts", "src/utils.ts"],
      changeSummary: "2 files changed",
    },
    transcript: { messageCount: 42 },
    createdAt: "2026-04-09T10:00:00.000Z",
    ...overrides,
  };
}

describe("buildContinuationContext", () => {
  it("returns summary and agentPrompt", () => {
    const result = buildContinuationContext({
      checkpoint: makeCheckpointMeta(),
      scope: "all",
      filesRestored: true,
      transcriptRestored: true,
    });

    expect(result.summary).toContain("main-abc123-003-bash");
    expect(result.agentPrompt).toContain("## Checkpoint Restored");
    expect(result.agentPrompt).toContain("### Continue");
  });

  it("includes tool name and undo info for after_tool_call trigger", () => {
    const result = buildContinuationContext({
      checkpoint: makeCheckpointMeta(),
      scope: "all",
      filesRestored: true,
      transcriptRestored: true,
    });

    expect(result.agentPrompt).toContain("### Restored to: after `Bash`");
    expect(result.agentPrompt).toContain("subsequent tool calls have been undone");
    expect(result.summary).toContain("`Bash`");
  });

  it("includes diff when provided", () => {
    const diff = "--- a/src/index.ts\n+++ b/src/index.ts\n-old line\n+new line";
    const result = buildContinuationContext({
      checkpoint: makeCheckpointMeta(),
      diff,
      scope: "all",
      filesRestored: true,
      transcriptRestored: true,
    });

    expect(result.agentPrompt).toContain("### Diff");
    expect(result.agentPrompt).toContain("old line");
    expect(result.summary).toContain("Changes undone");
  });

  it("truncates long diffs in agentPrompt", () => {
    const longDiff = "x".repeat(5000);
    const result = buildContinuationContext({
      checkpoint: makeCheckpointMeta(),
      diff: longDiff,
      scope: "all",
      filesRestored: true,
      transcriptRestored: true,
    });

    expect(result.agentPrompt).toContain("(truncated)");
    expect(result.agentPrompt.length).toBeLessThan(longDiff.length);
  });

  it("describes files-only restore correctly", () => {
    const result = buildContinuationContext({
      checkpoint: makeCheckpointMeta(),
      scope: "files",
      filesRestored: true,
      transcriptRestored: false,
    });

    expect(result.agentPrompt).toContain("Workspace files have been rolled back");
    expect(result.agentPrompt).toContain("Conversation transcript was kept as-is");
  });

  it("describes transcript-only restore correctly", () => {
    const result = buildContinuationContext({
      checkpoint: makeCheckpointMeta(),
      scope: "transcript",
      filesRestored: false,
      transcriptRestored: true,
    });

    expect(result.agentPrompt).toContain("Conversation transcript was rolled back");
    expect(result.agentPrompt).toContain("Workspace files were kept as-is");
  });

  it("omits tool section for session_start trigger", () => {
    const result = buildContinuationContext({
      checkpoint: makeCheckpointMeta({
        trigger: { type: "session_start" },
      }),
      scope: "all",
      filesRestored: true,
      transcriptRestored: true,
    });

    expect(result.agentPrompt).not.toContain("### Undone Tool");
  });

  it("limits file list to 20 entries", () => {
    const files = Array.from({ length: 30 }, (_, i) => `src/file-${i}.ts`);
    const result = buildContinuationContext({
      checkpoint: makeCheckpointMeta({
        snapshot: {
          backendType: "copy",
          snapshotRef: "copy:test",
          filesChanged: files,
        },
      }),
      scope: "all",
      filesRestored: true,
      transcriptRestored: true,
    });

    expect(result.agentPrompt).toContain("file-19");
    expect(result.agentPrompt).not.toContain("file-20");
    expect(result.agentPrompt).toContain("... and 10 more");
  });
});
