// Checkpoint data model types.

export type CheckpointId = string;

export type TriggerMode = "all_tools" | "mutating_tools" | "manual";
export type RestoreScope = "files" | "transcript" | "all";

export type CheckpointTrigger = {
  type: "after_tool_call" | "manual" | "session_start";
  toolName?: string;
  toolCallId?: string;
};

export type CheckpointGitState = {
  /** Detached commit SHA created via git commit-tree. */
  commitSha: string;
  /** Tree object SHA for the commit. */
  treeSha: string;
  /** Files changed relative to parent checkpoint. */
  filesChanged: string[];
  /** Human-readable diff stat summary. */
  diffStat?: string;
};

export type CheckpointTranscriptState = {
  /** Number of messages in session transcript at checkpoint time. */
  messageCount: number;
  /** Byte offset in the session JSONL file for restore. */
  byteOffset: number;
};

export type CheckpointToolResult = {
  success: boolean;
  errorMessage?: string;
};

export type CheckpointMeta = {
  id: CheckpointId;
  parentId: CheckpointId | null;
  sessionId: string;
  agentId: string;
  runId: string;
  trigger: CheckpointTrigger;
  git: CheckpointGitState;
  transcript: CheckpointTranscriptState;
  createdAt: string;
  toolDurationMs?: number;
  toolResult?: CheckpointToolResult;
};

export type CheckpointManifest = {
  sessionId: string;
  agentId: string;
  checkpoints: CheckpointId[];
  currentHead: CheckpointId | null;
};

export type CheckpointPluginConfig = {
  enabled: boolean;
  storagePath: string;
  triggerOn: TriggerMode;
  excludeTools: string[];
  maxCheckpointsPerSession: number;
  retentionDays: number;
  restoreDefaultScope: RestoreScope;
};
