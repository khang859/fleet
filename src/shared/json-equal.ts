/**
 * Whether two JSON-shaped values are the same value.
 *
 * Serialising both sides is exact for what these callers hold - values that
 * came out of `JSON.parse`, so no dates, sets, or cycles - and key order is
 * preserved by the parse, so two objects read from the same document compare
 * equal. Do not reach for this on values built by hand in two places, where
 * key order can differ.
 */
export function jsonEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
