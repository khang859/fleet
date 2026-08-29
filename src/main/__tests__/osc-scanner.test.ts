import { describe, it, expect } from 'vitest';
import { OscScanner } from '../osc-scanner';

const BEL = '\x07';
const ST = '\x1b\\';

function osc(code: number, payload: string, terminator = BEL): string {
  return `\x1b]${code};${payload}${terminator}`;
}

describe('OscScanner', () => {
  it('reads a whole sequence out of one chunk', () => {
    const scanner = new OscScanner();
    expect(scanner.scan('p', `hello${osc(52, 'c;aGk=')}world`)).toEqual([
      { code: 52, payload: 'c;aGk=' }
    ]);
  });

  it('accepts both BEL and ST terminators', () => {
    const scanner = new OscScanner();
    expect(scanner.scan('p', osc(7, 'file://h/a', ST))).toEqual([
      { code: 7, payload: 'file://h/a' }
    ]);
  });

  it('reads several sequences from one chunk', () => {
    const scanner = new OscScanner();
    expect(scanner.scan('p', osc(7, 'file://h/a') + 'text' + osc(52, 'c;eA=='))).toEqual([
      { code: 7, payload: 'file://h/a' },
      { code: 52, payload: 'c;eA==' }
    ]);
  });

  // The reason this class exists: PtyManager flushes every 16 ms, so a large
  // clipboard payload is delivered in pieces.
  it('reassembles a sequence split at every byte offset', () => {
    const full = `before${osc(52, 'c;' + 'QUJD'.repeat(50))}after`;
    for (let cut = 1; cut < full.length; cut++) {
      const scanner = new OscScanner();
      const tokens = [
        ...scanner.scan('p', full.slice(0, cut)),
        ...scanner.scan('p', full.slice(cut))
      ];
      expect(tokens, `split at ${cut}`).toEqual([{ code: 52, payload: 'c;' + 'QUJD'.repeat(50) }]);
    }
  });

  it('carries a trailing lone ESC into the next chunk', () => {
    const scanner = new OscScanner();
    expect(scanner.scan('p', 'text\x1b')).toEqual([]);
    expect(scanner.scan('p', `]7;file://h/a${BEL}`)).toEqual([{ code: 7, payload: 'file://h/a' }]);
  });

  it('keeps panes apart', () => {
    const scanner = new OscScanner();
    expect(scanner.scan('a', '\x1b]52;c;')).toEqual([]);
    expect(scanner.scan('b', osc(7, 'file://h/b'))).toEqual([{ code: 7, payload: 'file://h/b' }]);
    expect(scanner.scan('a', `aGk=${BEL}`)).toEqual([{ code: 52, payload: 'c;aGk=' }]);
  });

  it('drops a sequence that never terminates rather than growing forever', () => {
    const scanner = new OscScanner();
    scanner.scan('p', '\x1b]52;c;');
    // Two megabytes of payload with no terminator in sight.
    scanner.scan('p', 'A'.repeat(2 * 1024 * 1024));
    // The abandoned sequence must not swallow the next real one.
    expect(scanner.scan('p', osc(7, 'file://h/a'))).toEqual([{ code: 7, payload: 'file://h/a' }]);
  });

  it('ignores a body with no code or no separator', () => {
    const scanner = new OscScanner();
    expect(scanner.scan('p', `\x1b]${BEL}\x1b];payload${BEL}\x1b]notanumber;x${BEL}`)).toEqual([]);
  });

  it('forgets a closed pane', () => {
    const scanner = new OscScanner();
    scanner.scan('p', '\x1b]52;c;aGk');
    scanner.forget('p');
    expect(scanner.scan('p', `=${BEL}`)).toEqual([]);
  });
});
