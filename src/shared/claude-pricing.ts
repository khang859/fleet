// src/shared/claude-pricing.ts
// Pure pricing table + cost math for Claude sessions. No electron/node imports.
import { z } from 'zod';

/** Per-model pricing entry. Rates are USD per 1,000,000 tokens. */
export const modelPriceSchema = z.object({
  prefix: z.string(),
  input: z.number(),
  output: z.number(),
  cacheReadMult: z.number(),
  cacheWrite5mMult: z.number(),
  cacheWrite1hMult: z.number()
});
export type ModelPrice = z.infer<typeof modelPriceSchema>;

export const priceTableSchema = z.object({
  schemaVersion: z.literal(1),
  updated: z.string(),
  models: z.array(modelPriceSchema)
});
export type PriceTable = z.infer<typeof priceTableSchema>;

/** Token counts for cost math. Mirrors ClaudeUsage in shared/sessions.ts. */
export type ClaudeUsageInput = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
};

/**
 * Bundled fallback table. Also the seed and the source of truth for
 * resources/claude-pricing.json (kept in sync by a test). Cache multipliers are
 * uniform today (read 0.1×, 5m-write 1.25×, 1h-write 2×) but carried per-entry to
 * future-proof against Anthropic changing cache economics.
 */
export const BUNDLED_PRICES: PriceTable = {
  schemaVersion: 1,
  updated: '2026-06-12',
  models: [
    {
      prefix: 'claude-fable-',
      input: 10,
      output: 50,
      cacheReadMult: 0.1,
      cacheWrite5mMult: 1.25,
      cacheWrite1hMult: 2
    },
    {
      prefix: 'claude-mythos-',
      input: 10,
      output: 50,
      cacheReadMult: 0.1,
      cacheWrite5mMult: 1.25,
      cacheWrite1hMult: 2
    },
    {
      prefix: 'claude-opus-4-',
      input: 5,
      output: 25,
      cacheReadMult: 0.1,
      cacheWrite5mMult: 1.25,
      cacheWrite1hMult: 2
    },
    {
      prefix: 'claude-sonnet-4-',
      input: 3,
      output: 15,
      cacheReadMult: 0.1,
      cacheWrite5mMult: 1.25,
      cacheWrite1hMult: 2
    },
    {
      prefix: 'claude-haiku-4-',
      input: 1,
      output: 5,
      cacheReadMult: 0.1,
      cacheWrite5mMult: 1.25,
      cacheWrite1hMult: 2
    }
  ]
};

/** Longest-prefix match on the model id. Returns undefined when nothing matches. */
export function resolvePrice(model: string, table: PriceTable): ModelPrice | undefined {
  let best: ModelPrice | undefined;
  for (const entry of table.models) {
    if (model.startsWith(entry.prefix) && (!best || entry.prefix.length > best.prefix.length)) {
      best = entry;
    }
  }
  return best;
}

/** Cost for one usage bucket against one model. undefined when the model is unpriced. */
export function estimateCostUsd(
  usage: ClaudeUsageInput,
  model: string,
  table: PriceTable
): number | undefined {
  const p = resolvePrice(model, table);
  if (!p) return undefined;
  const perInputTok = p.input / 1_000_000;
  return (
    usage.input * perInputTok +
    usage.output * (p.output / 1_000_000) +
    usage.cacheRead * perInputTok * p.cacheReadMult +
    usage.cacheWrite5m * perInputTok * p.cacheWrite5mMult +
    usage.cacheWrite1h * perInputTok * p.cacheWrite1hMult
  );
}

/** Sum cost across a session's per-model usage. undefined if ANY model is unpriced. */
export function estimateSessionCostUsd(
  perModel: Map<string, ClaudeUsageInput>,
  table: PriceTable
): number | undefined {
  if (perModel.size === 0) return undefined; // no usage data
  let total = 0;
  for (const [model, usage] of perModel) {
    const c = estimateCostUsd(usage, model, table);
    if (c === undefined) return undefined;
    total += c;
  }
  return total;
}
