import type { ChatMessage } from '../../../../shared/chat-types';

/** Compact token count: 1234 → "1.2k", 980 → "980". */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
}

/** USD with enough precision to be useful at sub-cent scale. */
export function formatUsd(cost: number): string {
  if (cost === 0) return '$0';
  if (cost >= 1) return `$${cost.toFixed(2)}`;
  if (cost >= 0.01) return `$${cost.toFixed(3)}`;
  return `$${cost.toFixed(5)}`;
}

/** Running total over the assistant turns on the active path. */
export function sumUsage(messages: ChatMessage[]): {
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  cost: number;
  hasCost: boolean;
} {
  let promptTokens = 0;
  let completionTokens = 0;
  let cachedTokens = 0;
  let cost = 0;
  let hasCost = false;
  for (const m of messages) {
    if (!m.usage) continue;
    promptTokens += m.usage.promptTokens;
    completionTokens += m.usage.completionTokens;
    cachedTokens += m.usage.cachedTokens;
    if (m.usage.cost != null) {
      cost += m.usage.cost;
      hasCost = true;
    }
  }
  return { promptTokens, completionTokens, cachedTokens, cost, hasCost };
}
