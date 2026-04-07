import type { CheckpointEngine } from "./engine.js";

const SIX_HOURS = 6 * 60 * 60 * 1000;

/**
 * Background service that periodically prunes expired checkpoints.
 */
export function createPruningService(engine: CheckpointEngine) {
  let timer: ReturnType<typeof setInterval> | null = null;

  return {
    id: "agent-checkpoint-pruning",

    async start(ctx: { logger: { info(msg: string): void; warn(msg: string): void } }) {
      const runPrune = async () => {
        try {
          const pruned = await engine.pruneOld();
          if (pruned > 0) ctx.logger.info(`Pruned ${pruned} expired checkpoint(s)`);
        } catch (error) {
          ctx.logger.warn(`Checkpoint pruning failed: ${String(error)}`);
        }
      };

      await runPrune();
      timer = setInterval(runPrune, SIX_HOURS);
      ctx.logger.info("Checkpoint pruning service started");
    },

    async stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}
