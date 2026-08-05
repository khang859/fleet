/** Token counts as humans read them: 64000 → "64k", 1000000 → "1M". */
export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_000_000;
    return `${millions % 1 === 0 ? millions : millions.toFixed(1)}M`;
  }
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}k`;
  return String(tokens);
}

/** models.dev quotes USD per million tokens. */
export function formatCost(cost: { input: number; output: number }): string {
  const price = (n: number): string => (n < 1 ? `$${n.toFixed(2)}` : `$${n}`);
  return `${price(cost.input)} / ${price(cost.output)} per 1M`;
}
