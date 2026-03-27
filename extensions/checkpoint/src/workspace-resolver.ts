/**
 * Resolves and caches workspace directories for agents.
 *
 * The `PluginHookToolContext` (after_tool_call) and `PluginHookSessionContext`
 * (session_start) do not include `workspaceDir`. However, the
 * `OpenClawPluginToolContext` passed to `registerTool` factory does.
 *
 * This resolver caches the workspace dir from the tool factory and makes it
 * available to hooks via agentId lookup.
 */
export class WorkspaceResolver {
  private readonly workspaceDirs = new Map<string, string>();

  /**
   * Record a workspace directory for an agent.
   * Called from the tool factory when the tool context becomes available.
   */
  setWorkspaceDir(agentId: string, workspaceDir: string): void {
    this.workspaceDirs.set(agentId, workspaceDir);
  }

  /**
   * Get the cached workspace directory for an agent.
   */
  getWorkspaceDir(agentId?: string): string | undefined {
    if (!agentId) {
      return undefined;
    }
    return this.workspaceDirs.get(agentId);
  }
}
