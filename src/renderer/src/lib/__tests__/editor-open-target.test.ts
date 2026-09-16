import { describe, it, expect } from 'vitest';
import { Text } from '@codemirror/state';
import { offsetForTarget } from '../editor-open-target';

// Offsets: 'aaa' 0-2, newline 3, 'bbbbb' 4-8, newline 9, 'cc' 10-11.
const doc = Text.of(['aaa', 'bbbbb', 'cc']);

describe('offsetForTarget', () => {
  it('puts the cursor at the start of the named line', () => {
    expect(offsetForTarget(doc, { line: 1 })).toBe(0);
    expect(offsetForTarget(doc, { line: 2 })).toBe(4);
    expect(offsetForTarget(doc, { line: 3 })).toBe(10);
  });

  it('counts the column from one, as tools print it', () => {
    expect(offsetForTarget(doc, { line: 2, col: 1 })).toBe(4);
    expect(offsetForTarget(doc, { line: 2, col: 3 })).toBe(6);
  });

  it('stops at the end of the line when the column runs past it', () => {
    expect(offsetForTarget(doc, { line: 3, col: 99 })).toBe(12);
  });

  it('stops at the last line when the line runs past the end of the file', () => {
    // The file shrank since the line number was printed.
    expect(offsetForTarget(doc, { line: 300 })).toBe(10);
  });

  it('treats a nonsensical position as the start of the file', () => {
    expect(offsetForTarget(doc, { line: 0 })).toBe(0);
    expect(offsetForTarget(doc, { line: -5 })).toBe(0);
    expect(offsetForTarget(doc, { line: 1, col: 0 })).toBe(0);
  });

  it('lands inside an empty document', () => {
    expect(offsetForTarget(Text.of(['']), { line: 4, col: 9 })).toBe(0);
  });
});
