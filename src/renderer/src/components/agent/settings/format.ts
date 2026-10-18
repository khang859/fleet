/** Token counts as humans read them: 64000 → "64k", 1000000 → "1M". */
export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) {
    // One place after the point, and none when it is 0: 1048576 is "1M", not "1.0M".
    return `${Number((tokens / 1_000_000).toFixed(1))}M`;
  }
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}k`;
  return String(tokens);
}

/** How long ago something happened, at the coarseness a glance wants. */
export function relativeTime(epochMs: number): string {
  const minutes = Math.round((Date.now() - epochMs) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/**
 * Input and output price per million tokens, as `$0.30 / $1.00`, or as
 * `$3 / $15` when both are whole dollars. Both take the same form.
 */
export function formatPrice(cost: { input: number; output: number }): string {
  const whole = [cost.input, cost.output].every((n) => Number.isInteger(n) && n >= 1);
  const price = (n: number): string => (whole ? `$${n}` : `$${n.toFixed(2)}`);
  return `${price(cost.input)} / ${price(cost.output)}`;
}

/** models.dev quotes USD per million tokens. */
export function formatCost(cost: { input: number; output: number }): string {
  return `${formatPrice(cost)} per 1M`;
}

/**
 * Money, at the precision the amount deserves.
 *
 * A session costs anything from a twentieth of a cent to several dollars, and
 * one number of decimal places cannot serve both: `$0.00` for a real cost reads
 * as free, and `$1.24000` reads as a machine talking. So the places follow the
 * magnitude, and the string stays short enough for a status line either way.
 */
export function formatUsd(cost: number): string {
  if (cost === 0) return '$0';
  if (cost >= 1) return `$${cost.toFixed(2)}`;
  if (cost >= 0.01) return `$${cost.toFixed(3)}`;
  return `$${cost.toFixed(5)}`;
}
