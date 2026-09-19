import { describe, it, expect } from 'vitest';
import { parseScript, splitLine } from '../run-script';

describe('splitLine', () => {
  it('splits on whitespace', () => {
    expect(splitLine('click   e12  --shot')).toEqual(['click', 'e12', '--shot']);
  });

  it('keeps single quotes literal', () => {
    expect(splitLine(`click 'role=button[name="Chat"]'`)).toEqual([
      'click',
      'role=button[name="Chat"]'
    ]);
    expect(splitLine(`eval '"a\\b"'`)).toEqual(['eval', '"a\\b"']);
  });

  it('allows escaped quotes and backslashes in double quotes', () => {
    expect(splitLine('type e1 "say \\"hi\\" \\\\ ok"')).toEqual(['type', 'e1', 'say "hi" \\ ok']);
  });

  it('escapes the next character outside quotes', () => {
    expect(splitLine('term-send a\\ b')).toEqual(['term-send', 'a b']);
  });

  it('keeps an empty quoted word', () => {
    expect(splitLine(`type e1 ''`)).toEqual(['type', 'e1', '']);
  });

  it('rejects an unterminated quote', () => {
    expect(() => splitLine(`click 'e12`, 7)).toThrow("line 7: unterminated ' quote");
  });
});

describe('parseScript', () => {
  it('skips blank lines and comments, and keeps line numbers', () => {
    const steps = parseScript('# setup\n\nfixture chat\n  click e3 --shot\r\n');
    expect(steps).toEqual([
      { line: 3, text: 'fixture chat', argv: ['fixture', 'chat'] },
      { line: 4, text: 'click e3 --shot', argv: ['click', 'e3', '--shot'] }
    ]);
  });
});
