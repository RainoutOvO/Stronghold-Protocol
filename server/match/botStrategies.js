// Registry only: implementations import the contract, not this module, to avoid registration/import cycles.
// The external host is loaded by llmGate.js, and only on a dev checkout (§35.66). A release has no `external` id.
import { createBotRegistry, defineBotStrategy } from './botStrategyContract.js';
import { EXTERNAL_BOT, llmIntegrationEnabledNow } from './llmGate.js';

// Registration does not enable external IO: the operator must select and configure it.
export const BOT_STRATEGIES = createBotRegistry(llmIntegrationEnabledNow && EXTERNAL_BOT ? [EXTERNAL_BOT] : []);

/** @param {string | import('./botStrategyContract.js').BotStrategyDefinition} [selection] */
export function getBotStrategy(selection = 'legacy', registry = BOT_STRATEGIES) {
  // An unset or empty selection means the original bot, at startup and in every match/tool.
  if (selection === '') selection = 'legacy';
  if (selection && typeof selection === 'object') return defineBotStrategy(selection);
  // A release package has no external host. Map the id back to the built-in bot instead of refusing to boot.
  // startServer logs that once; this remap stays quiet so a match child does not print it again.
  if (selection === 'external' && !llmIntegrationEnabledNow) selection = 'legacy';
  if (typeof selection !== 'string' || !Object.hasOwn(registry, selection)) {
    throw new Error(`Unknown bot strategy: ${String(selection)}; available: ${Object.keys(registry).join(', ')}`);
  }
  return registry[selection];
}
