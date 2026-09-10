import { isRecord } from '../../../shared/is-record';
/**
 * Targeted edits to a settings document.
 *
 * The form only ever changes the one key a control owns. Everything else -
 * `hooks`, a `statusLine` object, keys newer than Fleet's schema snapshot - is
 * parsed, left alone, and written back in the order it arrived. Rewriting the
 * whole document from the form's own model is what would silently delete a
 * key the form does not know about.
 */

export function parseSettings(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text.trim() === '' ? '{}' : text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Two-space indent with a trailing newline - what Claude Code's own files use. */
export function serializeSettings(value: Record<string, unknown>): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function valueAtPath(document: Record<string, unknown>, path: string[]): unknown {
  let current: unknown = document;
  for (const segment of path) {
    if (!isRecord(current)) return undefined;
    current = current[segment];
  }
  return current;
}

/** The object at a path, or an empty object when it is absent or not an object. */
export function recordAtPath(
  document: Record<string, unknown>,
  path: string[]
): Record<string, unknown> {
  const value = valueAtPath(document, path);
  return isRecord(value) ? value : {};
}

/** A shallow copy per level, so untouched branches keep their identity. */
export function setKeyAtPath(
  document: Record<string, unknown>,
  path: string[],
  value: unknown
): Record<string, unknown> {
  if (path.length === 0) return document;
  const [head, ...rest] = path;
  const next = { ...document };
  if (rest.length === 0) {
    next[head] = value;
    return next;
  }
  const child = next[head];
  next[head] = setKeyAtPath(isRecord(child) ? child : {}, rest, value);
  return next;
}

/**
 * Remove a key. An intermediate object left empty by the removal stays: it may
 * have been in the file before the form touched anything, and guessing that the
 * user wanted it gone would be a change they did not ask for.
 */
export function deleteKeyAtPath(
  document: Record<string, unknown>,
  path: string[]
): Record<string, unknown> {
  if (path.length === 0) return document;
  const [head, ...rest] = path;
  if (!(head in document)) return document;
  const next = { ...document };
  if (rest.length === 0) {
    delete next[head];
    return next;
  }
  const child = next[head];
  if (!isRecord(child)) return document;
  next[head] = deleteKeyAtPath(child, rest);
  return next;
}

/**
 * Apply one control's change to the document text.
 *
 * `undefined` (an emptied control) removes the key rather than writing `null`,
 * because Claude Code reads an absent key as "not set" and a present `null` as
 * a value it has to interpret.
 */
export function applySettingsEdit(text: string, path: string[], value: unknown): string | null {
  const document = parseSettings(text);
  if (!document) return null;
  const next =
    value === undefined ? deleteKeyAtPath(document, path) : setKeyAtPath(document, path, value);
  return serializeSettings(next);
}
