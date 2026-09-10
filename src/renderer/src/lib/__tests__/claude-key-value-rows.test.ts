import { describe, it, expect } from 'vitest';
import {
  adoptRows,
  commitRows,
  rowsMatchDocument,
  type KeyValueRow
} from '../claude-key-value-rows';

describe('commitRows', () => {
  it('drops rows that have no name yet', () => {
    expect(
      commitRows([
        ['A', '1'],
        ['', '']
      ])
    ).toEqual({ A: '1' });
  });

  it('reports an empty map as unset rather than as an empty object', () => {
    expect(commitRows([['', '']])).toBeUndefined();
    expect(commitRows([])).toBeUndefined();
  });

  it('keeps boolean values as booleans', () => {
    expect(commitRows([['plugin@1', true]])).toEqual({ 'plugin@1': true });
  });
});

describe('adoptRows', () => {
  it('keeps a freshly added nameless row that the document cannot hold', () => {
    const entries: KeyValueRow[] = [['A', '1']];
    const rows: KeyValueRow[] = [
      ['A', '1'],
      ['', '']
    ];
    expect(adoptRows(rows, entries)).toBe(rows);
  });

  it('keeps the first row of an empty map while it is being named', () => {
    expect(adoptRows([['', '']], [])).toEqual([['', '']]);
  });

  it('keeps a row that has just been given its name', () => {
    const rows: KeyValueRow[] = [['B', '2']];
    expect(adoptRows(rows, [['B', '2']])).toBe(rows);
  });

  it('takes the document when it moved on underneath the editor', () => {
    const entries: KeyValueRow[] = [['FROM_DISK', 'x']];
    expect(adoptRows([['A', '1']], entries)).toBe(entries);
  });
});

describe('rowsMatchDocument', () => {
  it('is true when adding an empty row changes nothing writable', () => {
    expect(
      rowsMatchDocument(
        [
          ['A', '1'],
          ['', '']
        ],
        [['A', '1']]
      )
    ).toBe(true);
  });

  it('is false once the new row has a name', () => {
    expect(
      rowsMatchDocument(
        [
          ['A', '1'],
          ['B', '2']
        ],
        [['A', '1']]
      )
    ).toBe(false);
  });

  it('is false when a row is removed', () => {
    expect(rowsMatchDocument([], [['A', '1']])).toBe(false);
  });
});
