import type { ChildProcess } from 'child_process';

/**
 * Cap on accumulated child-process stdout, in UTF-16 code units. Search tools
 * like mdfind/rg can emit hundreds of MB (e.g. mdfind across the whole home
 * directory); buffering that into one string and splitting it on newlines
 * OOMs the main-process V8 heap. 8M chars is far more than any caller's
 * result limit needs.
 */
export const MAX_STDOUT_CHARS = 8 * 1024 * 1024;

export type BoundedStdout = {
  readonly text: string;
  readonly truncated: boolean;
};

/**
 * Accumulate a child process's stdout into a string, SIGTERM-ing the process
 * once the accumulated length exceeds `maxChars`. Already-buffered output is
 * kept and may end mid-line — line parsers must tolerate a partial last line.
 */
export function captureBoundedStdout(
  proc: ChildProcess,
  maxChars: number = MAX_STDOUT_CHARS
): BoundedStdout {
  let text = '';
  let truncated = false;
  proc.stdout?.on('data', (chunk: Buffer) => {
    if (truncated) return;
    text += chunk.toString();
    if (text.length > maxChars) {
      truncated = true;
      proc.kill('SIGTERM');
    }
  });
  return {
    get text() {
      return text;
    },
    get truncated() {
      return truncated;
    }
  };
}
