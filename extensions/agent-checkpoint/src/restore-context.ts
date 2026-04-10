import type { CheckpointMeta } from "./types.js";

export type ContinuationContext = {
  /** Human-readable summary for display (slash command, timeline UI). */
  summary: string;
  /**
   * Structured prompt fragment the agent sees as a tool result.
   * Designed so the LLM naturally understands what happened and what to do next.
   */
  agentPrompt: string;
};

/**
 * Build a continuation context that gives the agent enough information to
 * resume work after a checkpoint restore — mirroring the "restore = ready"
 * pattern used by the OpenClaw gateway's session compaction restore.
 *
 * The agent prompt answers three questions:
 *   1. What just happened?  (restore details)
 *   2. What was undone?     (diff / changed files)
 *   3. What should I do?    (continuation guidance)
 */
export function buildContinuationContext(params: {
  checkpoint: CheckpointMeta;
  diff?: string;
  scope: string;
  filesRestored: boolean;
  transcriptRestored: boolean;
}): ContinuationContext {
  const { checkpoint: cp, diff, scope, filesRestored, transcriptRestored } = params;
  const trigger = cp.trigger;
  const filesCount = cp.snapshot.filesChanged.length;
  const time = new Date(cp.createdAt).toLocaleString();

  // --- Human-readable summary (for slash command / UI) ---
  const summaryParts = [
    `Restored to checkpoint \`${cp.id}\` (${time})`,
    `Scope: ${scope} | Files: ${filesCount} restored`,
  ];
  if (trigger.type === "after_tool_call" && trigger.toolName) {
    summaryParts.push(`Checkpoint was saved after \`${trigger.toolName}\` — all subsequent changes have been undone.`);
  }
  if (diff) {
    summaryParts.push("", "**Changes undone:**", "```", diff.slice(0, 2000), "```");
  }
  if (transcriptRestored) {
    summaryParts.push("", "> Please refresh the dashboard to see the restored conversation.");
  }

  // --- Agent prompt (tool result the LLM sees) ---
  const promptParts: string[] = [];

  // Section 1: What happened
  promptParts.push("## Checkpoint Restored");
  promptParts.push(`You have been restored to checkpoint \`${cp.id}\` (created ${time}).`);

  if (filesRestored && transcriptRestored) {
    promptParts.push("Both workspace files and conversation transcript have been rolled back to this point.");
  } else if (filesRestored) {
    promptParts.push("Workspace files have been rolled back. Conversation transcript was kept as-is.");
  } else if (transcriptRestored) {
    promptParts.push("Conversation transcript was rolled back. Workspace files were kept as-is.");
  }

  // Section 2: What was undone
  if (trigger.type === "after_tool_call" && trigger.toolName) {
    promptParts.push("");
    promptParts.push(`### Restored to: after \`${trigger.toolName}\``);

    promptParts.push("The workspace is now in the state right after this tool executed. All subsequent tool calls have been undone.");
  }

  if (filesCount > 0) {
    promptParts.push("");
    promptParts.push(`### Files at Checkpoint (${filesCount})`);
    const fileList = cp.snapshot.filesChanged.slice(0, 20);
    for (const f of fileList) {
      promptParts.push(`- ${f}`);
    }
    if (filesCount > 20) {
      promptParts.push(`- ... and ${filesCount - 20} more`);
    }
  }

  if (diff) {
    const trimmedDiff = diff.length > 3000 ? diff.slice(0, 3000) + "\n... (truncated)" : diff;
    promptParts.push("");
    promptParts.push("### Diff (changes that were undone)");
    promptParts.push("```diff");
    promptParts.push(trimmedDiff);
    promptParts.push("```");
  }

  // Section 3: Continuation guidance
  promptParts.push("");
  promptParts.push("### Continue");
  promptParts.push("Your full conversation context is intact. You can see the restored workspace on disk.");
  promptParts.push("Review the current state and continue the task from this point.");

  return {
    summary: summaryParts.join("\n"),
    agentPrompt: promptParts.join("\n"),
  };
}
