import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

/**
 * Creates a callback that updates the session store when a transcript is restored
 * to a new file, following the same pattern as core compaction checkpoint restore.
 *
 * The callback:
 * 1. Resolves the session store path
 * 2. Loads the session store
 * 3. Updates the session entry to point to the new transcript file
 * 4. Resets runtime state (systemSent, abortedLastRun) so the agent re-initializes
 * 5. Saves the session store
 */
export function createTranscriptRestoreHandler(
  api: OpenClawPluginApi,
): (agentId: string, sessionId: string, newTranscriptPath: string) => Promise<void> {
  return async (_agentId: string, sessionId: string, newTranscriptPath: string) => {
    const { resolveStorePath, loadSessionStore, saveSessionStore } = api.runtime.agent.session;
    const storePath = resolveStorePath(api.config.session?.store);

    const store = loadSessionStore(storePath);

    // Find the session entry by sessionId
    for (const [key, entry] of Object.entries(store)) {
      if (entry.sessionId === sessionId) {
        store[key] = {
          ...entry,
          sessionFile: newTranscriptPath,
          updatedAt: Date.now(),
          // Reset runtime state so the agent re-sends system prompt (same as core cloneCheckpointSessionEntry)
          systemSent: false,
          abortedLastRun: false,
        };
        api.logger?.info(`Session store updated: ${key} → ${newTranscriptPath}`);
        break;
      }
    }

    await saveSessionStore(storePath, store);
  };
}
