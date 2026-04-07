export type CheckpointId = string;

export type TriggerMode = "all_tools" | "mutating_tools" | "manual";
export type RestoreScope = "files" | "transcript" | "all";

export type CheckpointTrigger = {
  type: "after_tool_call" | "manual" | "session_start";
  toolName?: string;
  toolCallId?: string;
};

/** Backend-agnostic snapshot state. */
export type CheckpointSnapshotState = {
  backendType: string;
  snapshotRef: string;
  filesChanged: string[];
  changeSummary?: string;
};

export type CheckpointTranscriptState = {
  messageCount: number;
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
  snapshot: CheckpointSnapshotState;
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
  backendType: string;
  backendConfig: Record<string, unknown>;
  triggerOn: TriggerMode;
  excludeTools: string[];
  maxCheckpointsPerSession: number;
  retentionDays: number;
  restoreDefaultScope: RestoreScope;
};
