/**
 * A plain JSON object, as opposed to an array, `null`, or a primitive.
 *
 * One copy for the whole tree. Everywhere this guard is used the value came
 * from parsing JSON someone else wrote, so every caller has to agree on what
 * counts as an object.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
