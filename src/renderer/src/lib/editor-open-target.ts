import type { Text } from '@codemirror/state';
import type { FileOpenTarget } from '../../../shared/types';

/**
 * Turn a printed `line:col` into a CodeMirror document offset.
 *
 * Two counting systems meet here: tools print 1-based lines and columns, and
 * CodeMirror addresses a document by a single 0-based character offset. Getting
 * that wrong puts the cursor a line off, which is the kind of thing nobody
 * notices until they are chasing a bug at the wrong line.
 *
 * Both coordinates are clamped rather than trusted. The number came off the
 * screen, and the file may well have been edited since it was printed - an
 * agent's `a.ts:300` against a file that is now 12 lines long should land at the
 * end, not throw.
 */
export function offsetForTarget(doc: Text, target: FileOpenTarget): number {
  const lineNumber = Math.min(Math.max(Math.trunc(target.line), 1), doc.lines);
  const line = doc.line(lineNumber);
  const col = Math.max(Math.trunc(target.col ?? 1), 1);
  return Math.min(line.from + col - 1, line.to);
}
