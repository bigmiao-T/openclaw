import os from "node:os";
import path from "node:path";
import type { OpenClawPluginConfigSchema } from "../api.js";
import type { CheckpointPluginConfig, TriggerMode, RestoreScope } from "./types.js";

const TRIGGER_MODES: TriggerMode[] = ["all_tools", "mutating_tools", "manual"];
const RESTORE_SCOPES: RestoreScope[] = ["files", "transcript", "all"];

const DEFAULT_EXCLUDE_TOOLS = ["read", "glob", "grep", "memory_search", "memory_get"];

export const DEFAULT_CHECKPOINT_CONFIG: CheckpointPluginConfig = {
  enabled: true,
  storagePath: path.join(os.homedir(), ".openclaw", "checkpoints"),
  triggerOn: "mutating_tools",
  excludeTools: DEFAULT_EXCLUDE_TOOLS,
  maxCheckpointsPerSession: 200,
  retentionDays: 30,
  restoreDefaultScope: "all",
};

type RawConfig = {
  enabled?: boolean;
  storagePath?: string;
  triggerOn?: string;
  excludeTools?: string[];
  maxCheckpointsPerSession?: number;
  retentionDays?: number;
  restoreDefaultScope?: string;
};

export function resolveCheckpointConfig(config: unknown): CheckpointPluginConfig {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return { ...DEFAULT_CHECKPOINT_CONFIG };
  }

  const raw = config as RawConfig;

  return {
    enabled: raw.enabled !== false,
    storagePath: normalizeStoragePath(raw.storagePath),
    triggerOn: normalizeTriggerMode(raw.triggerOn),
    excludeTools: normalizeExcludeTools(raw.excludeTools),
    maxCheckpointsPerSession: normalizePositiveInt(
      raw.maxCheckpointsPerSession,
      DEFAULT_CHECKPOINT_CONFIG.maxCheckpointsPerSession,
      1,
      1000,
    ),
    retentionDays: normalizePositiveInt(
      raw.retentionDays,
      DEFAULT_CHECKPOINT_CONFIG.retentionDays,
      1,
      365,
    ),
    restoreDefaultScope: normalizeRestoreScope(raw.restoreDefaultScope),
  };
}

export const checkpointPluginConfigSchema: OpenClawPluginConfigSchema = {
  safeParse(value: unknown) {
    if (value === undefined) {
      return { success: true, data: undefined };
    }
    try {
      return { success: true, data: resolveCheckpointConfig(value) };
    } catch (error) {
      return {
        success: false,
        error: {
          issues: [{ path: [], message: error instanceof Error ? error.message : String(error) }],
        },
      };
    }
  },
  jsonSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      enabled: { type: "boolean", default: true },
      storagePath: { type: "string" },
      triggerOn: {
        type: "string",
        enum: [...TRIGGER_MODES],
        default: DEFAULT_CHECKPOINT_CONFIG.triggerOn,
      },
      excludeTools: {
        type: "array",
        items: { type: "string" },
        default: DEFAULT_EXCLUDE_TOOLS,
      },
      maxCheckpointsPerSession: {
        type: "number",
        minimum: 1,
        maximum: 1000,
        default: DEFAULT_CHECKPOINT_CONFIG.maxCheckpointsPerSession,
      },
      retentionDays: {
        type: "number",
        minimum: 1,
        maximum: 365,
        default: DEFAULT_CHECKPOINT_CONFIG.retentionDays,
      },
      restoreDefaultScope: {
        type: "string",
        enum: [...RESTORE_SCOPES],
        default: DEFAULT_CHECKPOINT_CONFIG.restoreDefaultScope,
      },
    },
  },
};

function normalizeStoragePath(value?: string): string {
  if (!value || typeof value !== "string" || value.trim().length === 0) {
    return DEFAULT_CHECKPOINT_CONFIG.storagePath;
  }
  return path.resolve(value.trim());
}

function normalizeTriggerMode(value?: string): TriggerMode {
  if (value && TRIGGER_MODES.includes(value as TriggerMode)) {
    return value as TriggerMode;
  }
  return DEFAULT_CHECKPOINT_CONFIG.triggerOn;
}

function normalizeRestoreScope(value?: string): RestoreScope {
  if (value && RESTORE_SCOPES.includes(value as RestoreScope)) {
    return value as RestoreScope;
  }
  return DEFAULT_CHECKPOINT_CONFIG.restoreDefaultScope;
}

function normalizeExcludeTools(value?: string[]): string[] {
  if (!Array.isArray(value)) {
    return [...DEFAULT_EXCLUDE_TOOLS];
  }
  return value.filter((item) => typeof item === "string" && item.trim().length > 0);
}

function normalizePositiveInt(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined || !Number.isFinite(value)) {
    return fallback;
  }
  const rounded = Math.floor(value);
  return Math.min(Math.max(rounded, min), max);
}
