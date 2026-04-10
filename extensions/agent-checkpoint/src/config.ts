import os from "node:os";
import path from "node:path";
import type { CheckpointPluginConfig, TriggerMode, RestoreScope } from "./types.js";

const TRIGGER_MODES: TriggerMode[] = ["auto", "manual"];
const RESTORE_SCOPES: RestoreScope[] = ["files", "transcript", "all"];
const DEFAULT_EXCLUDE_TOOLS = ["read", "glob", "grep", "memory_search", "memory_get"];

export const DEFAULT_CONFIG: CheckpointPluginConfig = {
  enabled: true,
  storagePath: path.join(os.homedir(), ".openclaw", "checkpoints"),
  backendType: "copy",
  backendConfig: {},
  triggerOn: "auto",
  excludeTools: DEFAULT_EXCLUDE_TOOLS,
  maxCheckpointsPerSession: 200,
  retentionDays: 30,
  restoreDefaultScope: "all",
};

type RawConfig = {
  enabled?: boolean;
  storagePath?: string;
  backendType?: string;
  backendConfig?: Record<string, unknown>;
  triggerOn?: string;
  excludeTools?: string[];
  maxCheckpointsPerSession?: number;
  retentionDays?: number;
  restoreDefaultScope?: string;
};

export function resolveConfig(raw: unknown): CheckpointPluginConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ...DEFAULT_CONFIG };
  }

  const c = raw as RawConfig;

  return {
    enabled: c.enabled !== false,
    storagePath: normalizeString(c.storagePath, DEFAULT_CONFIG.storagePath, path.resolve),
    backendType: c.backendType === "copy" ? "copy" : DEFAULT_CONFIG.backendType,
    backendConfig:
      c.backendConfig && typeof c.backendConfig === "object" && !Array.isArray(c.backendConfig)
        ? c.backendConfig
        : {},
    triggerOn: includes(TRIGGER_MODES, c.triggerOn) ? c.triggerOn : DEFAULT_CONFIG.triggerOn,
    excludeTools: Array.isArray(c.excludeTools)
      ? c.excludeTools.filter((t) => typeof t === "string" && t.trim().length > 0)
      : [...DEFAULT_EXCLUDE_TOOLS],
    maxCheckpointsPerSession: clampInt(c.maxCheckpointsPerSession, 1, 1000, 200),
    retentionDays: clampInt(c.retentionDays, 1, 365, 30),
    restoreDefaultScope: includes(RESTORE_SCOPES, c.restoreDefaultScope)
      ? c.restoreDefaultScope
      : DEFAULT_CONFIG.restoreDefaultScope,
  };
}

function normalizeString(
  value: string | undefined,
  fallback: string,
  transform?: (v: string) => string,
): string {
  if (!value || typeof value !== "string" || value.trim().length === 0) return fallback;
  return transform ? transform(value.trim()) : value.trim();
}

function clampInt(
  value: number | undefined,
  min: number,
  max: number,
  fallback: number,
): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.floor(value), min), max);
}

function includes<T extends string>(list: T[], value: string | undefined): value is T {
  return typeof value === "string" && (list as string[]).includes(value);
}
