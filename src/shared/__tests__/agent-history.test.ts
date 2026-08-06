import { describe, expect, it } from 'vitest';
import {
  HISTORY_IDLE,
  HISTORY_LIMIT,
  historyStep,
  recallable,
  type AgentHistoryCursor,
  type AgentHistoryEntry
} from '../agent-history';

function entry(text: string, cwd = '/repo', at = 0): AgentHistoryEntry {
  return { text, cwd, at };
}

describe('recallable', () => {
  it('hands back the newest first', () => {
    expect(recallable([entry('one'), entry('two'), entry('three')], '/repo')).toEqual([
      'three',
      'two',
      'one'
    ]);
  });

  it('keeps only the folder asked for', () => {
    const entries = [entry('mine'), entry('theirs', '/other'), entry('mine too')];
    expect(recallable(entries, '/repo')).toEqual(['mine too', 'mine']);
  });

  it('collapses a repeat to its newest occurrence', () => {
    const entries = [entry('run the tests'), entry('fix it'), entry('run the tests')];
    expect(recallable(entries, '/repo')).toEqual(['run the tests', 'fix it']);
  });

  it('collapses a run of the same prompt written back to back', () => {
    const entries = [entry('again'), entry('again'), entry('again')];
    expect(recallable(entries, '/repo')).toEqual(['again']);
  });

  it('drops empty text', () => {
    expect(recallable([entry('real'), entry('')], '/repo')).toEqual(['real']);
  });

  it('stops at the limit, counting distinct prompts', () => {
    const entries = Array.from({ length: 250 }, (_, i) => entry(`prompt ${i}`));
    const list = recallable(entries, '/repo');
    expect(list).toHaveLength(HISTORY_LIMIT);
    // Newest first, so the last one typed is at the front and the cut is at the
    // old end - the opposite would put the limit between you and what you just
    // sent, which is the entry most likely to be wanted.
    expect(list[0]).toBe('prompt 249');
    expect(list.at(-1)).toBe('prompt 150');
  });

  it('is empty for a folder with nothing in it', () => {
    expect(recallable([entry('elsewhere', '/other')], '/repo')).toEqual([]);
  });

  it('treats a folder differing only in case as a different folder', () => {
    // macOS is usually case-insensitive, so these can be the same directory.
    // Reported cwds come from the same source per pane, so they agree; matching
    // exactly is what keeps this from claiming to normalise paths, which it
    // cannot do correctly without touching the filesystem.
    expect(recallable([entry('typed', '/Repo')], '/repo')).toEqual([]);
  });
});

describe('historyStep', () => {
  const entries = ['newest', 'middle', 'oldest'];

  it('goes back to the newest first, keeping the draft', () => {
    const step = historyStep(HISTORY_IDLE, 'back', entries, 'half a thought');
    expect(step).toEqual({ cursor: { index: 0, draft: 'half a thought' }, text: 'newest' });
  });

  it('walks further back one at a time', () => {
    const first = historyStep(HISTORY_IDLE, 'back', entries, '');
    const second = historyStep(first!.cursor, 'back', entries, first!.text);
    expect(second!.text).toBe('middle');
    const third = historyStep(second!.cursor, 'back', entries, second!.text);
    expect(third!.text).toBe('oldest');
  });

  it('stops at the oldest rather than wrapping', () => {
    const cursor: AgentHistoryCursor = { index: entries.length - 1, draft: '' };
    expect(historyStep(cursor, 'back', entries, 'oldest')).toBeNull();
  });

  it('refuses to start when there is nothing to recall', () => {
    expect(historyStep(HISTORY_IDLE, 'back', [], 'typing')).toBeNull();
  });

  it('hands the draft back on the way forward off the newest', () => {
    const back = historyStep(HISTORY_IDLE, 'back', entries, 'half a thought')!;
    const forward = historyStep(back.cursor, 'forward', entries, back.text)!;
    expect(forward.text).toBe('half a thought');
    expect(forward.cursor).toEqual(HISTORY_IDLE);
  });

  it('keeps the same draft through a long walk out and back', () => {
    let cursor = HISTORY_IDLE;
    let text = 'the thing I was writing';
    for (let i = 0; i < entries.length; i += 1) {
      const step = historyStep(cursor, 'back', entries, text)!;
      cursor = step.cursor;
      text = step.text;
    }
    for (let i = 0; i < entries.length; i += 1) {
      const step = historyStep(cursor, 'forward', entries, text)!;
      cursor = step.cursor;
      text = step.text;
    }
    expect(text).toBe('the thing I was writing');
    expect(cursor).toEqual(HISTORY_IDLE);
  });

  it('does nothing on the way forward when not walking', () => {
    expect(historyStep(HISTORY_IDLE, 'forward', entries, 'live text')).toBeNull();
  });

  it('sets aside an empty box as the draft, so Down clears it again', () => {
    const back = historyStep(HISTORY_IDLE, 'back', entries, '')!;
    const forward = historyStep(back.cursor, 'forward', entries, back.text)!;
    expect(forward.text).toBe('');
  });
});
