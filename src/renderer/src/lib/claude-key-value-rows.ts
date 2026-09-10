/**
 * The row model behind the environment and plugin editors.
 *
 * A JSON object cannot hold a nameless key, so a row the user has just added
 * has nowhere to live in the document yet. Deriving the rows straight from the
 * object therefore deletes each new row the instant it appears, which is what
 * made both Add buttons do nothing. The rows are their own list instead, and
 * only the named ones are committed.
 */

import { jsonEqual } from '../../../shared/json-equal';

export type KeyValueRow = [string, unknown];

/** The object these rows commit to, or `undefined` when nothing is named. */
export function commitRows(rows: KeyValueRow[]): Record<string, unknown> | undefined {
  const object: Record<string, unknown> = {};
  for (const [key, value] of rows) if (key !== '') object[key] = value;
  return Object.keys(object).length === 0 ? undefined : object;
}

/** What the committed rows look like, for comparing against the document. */
function namedRows(rows: KeyValueRow[]): KeyValueRow[] {
  return rows.filter(([key]) => key !== '');
}

/**
 * The rows to show, given the document's entries and the rows already on screen.
 *
 * Local rows are kept whenever their named part already says what the document
 * says - that is the ordinary case of a half-typed new row, and replacing the
 * list there would throw the row away. Anything else means the document moved
 * on underneath the editor (a reload, a scope switch, an edit in the Raw view)
 * and the document wins.
 */
export function adoptRows(rows: KeyValueRow[], entries: KeyValueRow[]): KeyValueRow[] {
  return jsonEqual(namedRows(rows), entries) ? rows : entries;
}

/** Whether committing these rows would change what the document already holds. */
export function rowsMatchDocument(rows: KeyValueRow[], entries: KeyValueRow[]): boolean {
  return jsonEqual(namedRows(rows), entries);
}
