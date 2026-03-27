import { definePluginEntry, type OpenClawPluginApi, type OpenClawPluginToolContext } from "./api.js";
import { CheckpointEngine } from "./src/checkpoint-engine.js";
import { checkpointPluginConfigSchema, resolveCheckpointConfig } from "./src/config.js";
import { registerCheckpointHooks } from "./src/hooks.js";
import { createCheckpointHttpHandler } from "./src/http.js";
import { CheckpointStore } from "./src/store.js";
import { createCheckpointTool } from "./src/tool.js";
import { WorkspaceResolver } from "./src/workspace-resolver.js";

export default definePluginEntry({
  id: "checkpoint",
  name: "Checkpoints",
  description: "Automatic checkpoint and rollback for agent workspaces.",
  configSchema: checkpointPluginConfigSchema,
  register(api: OpenClawPluginApi) {
    const config = resolveCheckpointConfig(api.pluginConfig);
    if (!config.enabled) {
      return;
    }

    const store = new CheckpointStore({
      rootDir: config.storagePath,
      logger: api.logger,
    });

    const engine = new CheckpointEngine({
      store,
      config,
      logger: api.logger,
    });

    const workspaceResolver = new WorkspaceResolver();

    // Register hooks for automatic checkpoint creation
    registerCheckpointHooks(api, engine, workspaceResolver);

    // Register agent tool for manual checkpoint management.
    // The tool factory receives OpenClawPluginToolContext which has workspaceDir;
    // we cache it in the workspace resolver for use by hooks.
    api.registerTool(
      (ctx: OpenClawPluginToolContext) => {
        if (ctx.agentId && ctx.workspaceDir) {
          workspaceResolver.setWorkspaceDir(ctx.agentId, ctx.workspaceDir);
        }
        return createCheckpointTool({ engine, context: ctx });
      },
      { name: "checkpoint" },
    );

    // Register HTTP routes for visualization UI
    api.registerHttpRoute({
      path: "/plugins/checkpoint",
      auth: "plugin",
      match: "prefix",
      handler: createCheckpointHttpHandler({
        store,
        engine,
        logger: api.logger,
      }),
    });

    api.logger?.info(`Checkpoint plugin enabled (storage: ${config.storagePath})`);
  },
});
