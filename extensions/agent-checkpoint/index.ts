import path from "node:path";
import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { resolveConfig } from "./src/config.js";
import { registerCheckpointCommand } from "./src/command.js";
import { CheckpointEngine } from "./src/engine.js";
import { cacheWorkspaceDir, registerCheckpointHooks } from "./src/hooks.js";
import { createPruningService } from "./src/pruning-service.js";
import { createSnapshotBackend, type BackendType } from "./src/snapshot-backend.js";
import { CheckpointStore } from "./src/store.js";
import { createCheckpointTool } from "./src/tool.js";

export default definePluginEntry({
  id: "agent-checkpoint",
  name: "Agent Checkpoint",
  description: "Automatic checkpoint and rollback for long-running agent tasks.",
  async register(api: OpenClawPluginApi) {
    const config = resolveConfig(api.pluginConfig);
    if (!config.enabled) return;

    const backend = await createSnapshotBackend({
      type: config.backendType as BackendType,
      storageDir: config.storagePath,
      backendConfig: config.backendConfig,
      logger: api.logger,
    });

    if (backend.init) await backend.init();

    const store = new CheckpointStore({
      rootDir: path.join(config.storagePath, "meta"),
      logger: api.logger,
    });

    const engine = new CheckpointEngine({
      store,
      backend,
      config,
      logger: api.logger,
    });

    // Auto-checkpoint hooks
    registerCheckpointHooks(api, engine);

    // Agent tool (also caches workspaceDir for hooks)
    api.registerTool(
      (ctx) => {
        cacheWorkspaceDir(ctx);
        return createCheckpointTool({ engine, context: ctx });
      },
      { name: "checkpoint" },
    );

    // /checkpoint slash command
    registerCheckpointCommand(api, engine);

    // Background pruning service
    api.registerService(createPruningService(engine));

    api.logger?.info(`Agent Checkpoint enabled (backend: ${config.backendType}, storage: ${config.storagePath})`);
  },
});
