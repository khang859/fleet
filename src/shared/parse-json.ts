import type { z } from 'zod';

/**
 * JSON text read through a schema: the value when it parses and fits, null
 * when it is missing, malformed, or the wrong shape. For stored JSON, where a
 * bad row should read as absent rather than throw.
 */
export function parseJsonAs<T>(schema: z.ZodType<T>, json: string | null): T | null {
  if (json === null) return null;
  try {
    const result = schema.safeParse(JSON.parse(json));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
