// Narrow plugin-sdk surface for the bundled checkpoint plugin.
// Keep this list additive and scoped to symbols used under extensions/checkpoint.

export { definePluginEntry } from "./plugin-entry.js";
export type { OpenClawConfig } from "../config/config.js";
export type {
  AnyAgentTool,
  OpenClawPluginApi,
  OpenClawPluginConfigSchema,
  OpenClawPluginToolContext,
  PluginLogger,
} from "../plugins/types.js";
