// Checkpoint plugin barrel — self-contained SDK types.
//
// The dedicated openclaw/plugin-sdk/checkpoint subpath exists in the repo
// source but is not published in every installed openclaw build.  To keep
// the plugin loadable from *any* installed version we define minimal
// structural types here instead of importing from an SDK subpath.

// ---------------------------------------------------------------------------
// Structural types — mirror the shapes from src/plugins/types.ts without
// importing internal paths.
// ---------------------------------------------------------------------------

/** Minimal logger interface matching PluginLogger. */
export type PluginLogger = {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  debug?(msg: string): void;
};

/** Minimal config schema shape. */
export type OpenClawPluginConfigSchema = Record<string, unknown>;

/** Minimal tool context passed to tool factory callbacks. */
export type OpenClawPluginToolContext = {
  agentId?: string;
  sessionId?: string;
  workspaceDir?: string;
  [key: string]: unknown;
};

/** Minimal agent tool shape. */
export type AnyAgentTool = {
  name: string;
  description: string;
  parameters?: Record<string, unknown>;
  execute?: (toolCallId: string, params: Record<string, unknown>) => Promise<unknown>;
};

/** Minimal plugin API shape used by the checkpoint plugin. */
export type OpenClawPluginApi = {
  pluginConfig: Record<string, unknown>;
  logger?: PluginLogger;
  on(
    hookName: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- hook callbacks receive runtime-typed event+context
    handler: (...args: any[]) => Promise<unknown> | unknown,
  ): void;
  registerTool(
    factory: (ctx: OpenClawPluginToolContext) => AnyAgentTool | AnyAgentTool[] | null | undefined,
    opts?: { name?: string },
  ): void;
  registerHttpRoute(opts: {
    path: string;
    auth: string;
    match?: string;
    handler: (req: unknown, res: unknown) => Promise<boolean>;
  }): void;
};

// ---------------------------------------------------------------------------
// definePluginEntry — identical semantics to src/plugin-sdk/plugin-entry.ts
// ---------------------------------------------------------------------------

type DefinePluginEntryOptions = {
  id: string;
  name: string;
  description: string;
  kind?: string;
  configSchema?: Record<string, unknown>;
  register: (api: OpenClawPluginApi) => void;
};

type DefinedPluginEntry = {
  id: string;
  name: string;
  description: string;
  configSchema: Record<string, unknown>;
  register: (api: OpenClawPluginApi) => void;
  kind?: string;
};

export function definePluginEntry({
  id,
  name,
  description,
  kind,
  configSchema = {},
  register,
}: DefinePluginEntryOptions): DefinedPluginEntry {
  return {
    id,
    name,
    description,
    ...(kind ? { kind } : {}),
    configSchema,
    register,
  };
}
