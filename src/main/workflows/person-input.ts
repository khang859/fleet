const ESC = '\\x1b';

/** What xterm sends by itself: status replies, focus changes, mouse moves, title replies. */
const TERMINAL_REPLY = new RegExp(
  '^(?:' +
    [
      `${ESC}\\[[?>=]?[\\d;]*[cnRtIO]`,
      `${ESC}\\[\\?[\\d;]*u`,
      `${ESC}\\[<[\\d;]*[Mm]`,
      `${ESC}\\][^\\x07${ESC}]*(?:\\x07|${ESC}\\\\)`,
      `${ESC}P[^${ESC}]*${ESC}\\\\`
    ].join('|') +
    ')+$'
);

/** Terminals answer a TUI through the same stream as the keyboard. Only keys mean a person. */
export function isPersonInput(data: string): boolean {
  return !TERMINAL_REPLY.test(data);
}
