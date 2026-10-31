import { describe, expect, it } from 'vitest';
import type { BoardItem } from '../../../shared/workflows';
import { Board, boardText, cleanText, isRepeat } from '../board';

function existing(fields: Partial<BoardItem>): BoardItem {
  return { id: '1', agent: 'A', kind: 'bug', text: 'text', ...fields };
}

describe('cleanText', () => {
  it('drops case and punctuation', () => {
    expect(cleanText('  Null-Pointer, here!! ')).toBe('null pointer here');
  });
});

describe('isRepeat', () => {
  it('matches code findings near each other', () => {
    const item = { kind: 'Bug', text: 'other words', file: 'a.ts', line: 15 };

    expect(isRepeat(item, existing({ file: 'a.ts', line: 10 }))).toBe(true);
    expect(isRepeat(item, existing({ file: 'a.ts', line: 9 }))).toBe(false);
  });

  it('needs the same file and kind', () => {
    const item = { kind: 'bug', text: 'text', file: 'a.ts', line: 1 };

    expect(isRepeat(item, existing({ file: 'b.ts', line: 1 }))).toBe(false);
    expect(isRepeat(item, existing({ kind: 'style', file: 'a.ts', line: 1 }))).toBe(false);
  });

  it('matches notes by source and text', () => {
    const item = { kind: 'note', text: 'TEXT.', source: 'link' };

    expect(isRepeat(item, existing({ source: 'link' }))).toBe(true);
    expect(isRepeat(item, existing({ source: 'other' }))).toBe(false);
  });

  it('matches plain items by text only', () => {
    expect(isRepeat({ kind: 'note', text: 'TEXT' }, existing({}))).toBe(true);
    expect(isRepeat({ kind: 'note', text: 'other' }, existing({}))).toBe(false);
  });

  it('never matches a plain item to a placed one', () => {
    expect(isRepeat({ kind: 'bug', text: 'text' }, existing({ file: 'a.ts' }))).toBe(false);
    expect(isRepeat({ kind: 'bug', text: 'text', file: 'a.ts' }, existing({}))).toBe(false);
  });
});

describe('Board', () => {
  it('adds items with growing ids', () => {
    const board = new Board();

    const first = board.add('A', { kind: 'bug', text: 'one' });
    const second = board.add('B', { kind: 'bug', text: 'two' });

    expect(first).toMatchObject({ added: true, item: { id: '1', agent: 'A' } });
    expect(second).toMatchObject({ added: true, item: { id: '2', agent: 'B' } });
    expect(board.list()).toHaveLength(2);
  });

  it('refuses a repeat and returns the item', () => {
    const board = new Board();
    board.add('A', { kind: 'bug', text: 'one' });

    const result = board.add('B', { kind: 'bug', text: 'ONE!' });

    expect(result).toMatchObject({ added: false, existing: { id: '1', agent: 'A' } });
    expect(board.all()).toHaveLength(1);
  });

  it('marks merged sources and lists only the new item', () => {
    const board = new Board();
    board.add('A', { kind: 'bug', text: 'one' });
    board.add('B', { kind: 'bug', text: 'two' });

    const merged = board.merge('Judge', ['1', '2'], { kind: 'bug', text: 'both' });

    expect(merged).toMatchObject({ id: '3', agent: 'Judge', mergedFrom: ['1', '2'] });
    expect(board.get('1')?.mergedInto).toBe('3');
    expect(board.get('2')?.mergedInto).toBe('3');
    expect(board.list().map((item) => item.id)).toEqual(['3']);
    expect(board.all()).toHaveLength(3);
  });

  it('refuses a merge of an unknown id and changes nothing', () => {
    const board = new Board();
    board.add('A', { kind: 'bug', text: 'one' });

    expect(() => board.merge('Judge', ['1', '9'], { kind: 'bug', text: 'x' })).toThrow('9');
    expect(board.get('1')?.mergedInto).toBeUndefined();
  });

  it('ignores merged items when it looks for a repeat', () => {
    const board = new Board();
    board.add('A', { kind: 'bug', text: 'one' });
    board.merge('Judge', ['1'], { kind: 'bug', text: 'merged' });

    expect(board.add('B', { kind: 'bug', text: 'one' }).added).toBe(true);
  });

  it('goes on from the highest stored id', () => {
    const board = new Board([existing({ id: '4' }), existing({ id: '9', text: 'b' })]);

    expect(board.add('A', { kind: 'bug', text: 'new' })).toMatchObject({ item: { id: '10' } });
  });

  it('marks a post state', () => {
    const board = new Board();
    board.add('A', { kind: 'bug', text: 'one' });

    board.mark('1', 'posted');

    expect(board.get('1')?.post).toBe('posted');
  });
});

describe('boardText', () => {
  it('writes place and source', () => {
    const text = boardText([
      existing({ file: 'a.ts', line: 3, text: 'bad' }),
      existing({ kind: 'note', file: 'b.ts', text: 'odd' }),
      existing({ kind: 'note', text: 'read', source: 'link' })
    ]);

    expect(text.split('\n')).toEqual([
      '- **bug** (a.ts:3): bad',
      '- **note** (b.ts): odd',
      '- **note**: read Source: link'
    ]);
  });
});
