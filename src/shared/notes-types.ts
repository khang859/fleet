/** Result of reading a project note. `mtimeMs` is 0 when no note exists yet. */
export type NoteReadResult = {
  text: string;
  mtimeMs: number;
};

/**
 * Result of writing a project note. `externalChange` signals the on-disk note
 * was modified (e.g. from another Fleet window) since the caller last read it,
 * so the write was refused to avoid clobbering.
 */
export type NoteWriteResult =
  | { ok: true; mtimeMs: number }
  | { ok: false; externalChange: true; mtimeMs: number };
