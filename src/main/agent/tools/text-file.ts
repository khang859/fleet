import { readFile, stat, writeFile } from 'node:fs/promises';
import { EDIT_MAX_FILE_BYTES } from '../../../shared/agent-tools';
import { remember } from './freshness';

/**
 * Reading and writing a file as text, without changing anything nobody asked to
 * change.
 *
 * Line endings are the one property of a file that a model cannot see and will
 * not preserve: it writes `\n` because that is what it was shown. So a CRLF
 * file is handed over as LF, matched as LF, and written back as CRLF - the
 * alternative is an edit of three lines that rewrites every line in the file
 * and produces a diff nobody can review.
 */

export type TextFile = { text: string; crlf: boolean };

export async function readTextFile(abs: string, shown: string): Promise<TextFile> {
  const raw = await readFile(abs, 'utf8');
  if (raw.includes('\u0000')) throw new Error(`${shown} is a binary file`);
  const crlf = raw.includes('\r\n');
  return { text: crlf ? raw.split('\r\n').join('\n') : raw, crlf };
}

/** Write text back in the file's own line endings, and record the new stamp. */
export async function writeTextFile(abs: string, text: string, crlf: boolean): Promise<void> {
  await writeFile(abs, crlf ? text.split('\n').join('\r\n') : text, 'utf8');
  remember(abs, await stat(abs));
}

/** Throw when a file is too big to hold in memory twice for the sake of one edit. */
export function checkEditableSize(size: number, shown: string): void {
  if (size > EDIT_MAX_FILE_BYTES) {
    throw new Error(
      `${shown} is ${Math.round(size / 1000)}kB, too large to rewrite - change it another way`
    );
  }
}
