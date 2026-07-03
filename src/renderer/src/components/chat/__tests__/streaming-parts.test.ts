import { describe, it, expect } from 'vitest';
import { appendTextPart, applyToolStatus, type StreamingPart } from '../streaming-parts';

describe('appendTextPart', () => {
  it('starts a text part when the list is empty', () => {
    expect(appendTextPart([], 'Hello')).toEqual([{ type: 'text', text: 'Hello' }]);
  });

  it('merges consecutive text deltas into the trailing text part', () => {
    const parts = appendTextPart([{ type: 'text', text: 'Hel' }], 'lo');
    expect(parts).toEqual([{ type: 'text', text: 'Hello' }]);
  });

  it('starts a new text part after a tool block (does not merge across it)', () => {
    const start: StreamingPart[] = [
      { type: 'text', text: 'before' },
      { type: 'tool', label: 'bash', state: 'done' }
    ];
    expect(appendTextPart(start, 'after')).toEqual([
      { type: 'text', text: 'before' },
      { type: 'tool', label: 'bash', state: 'done' },
      { type: 'text', text: 'after' }
    ]);
  });

  it('ignores an empty delta', () => {
    const start: StreamingPart[] = [{ type: 'text', text: 'x' }];
    expect(appendTextPart(start, '')).toEqual(start);
  });

  it('does not mutate the input array', () => {
    const start: StreamingPart[] = [{ type: 'text', text: 'a' }];
    appendTextPart(start, 'b');
    expect(start).toEqual([{ type: 'text', text: 'a' }]);
  });
});

describe('applyToolStatus', () => {
  it('appends a tool block after the current text (preserving order)', () => {
    const start: StreamingPart[] = [{ type: 'text', text: 'Let me check.' }];
    const parts = applyToolStatus(start, { state: 'generating', label: 'Running bash' });
    expect(parts).toEqual([
      { type: 'text', text: 'Let me check.' },
      { type: 'tool', label: 'Running bash', state: 'generating' }
    ]);
  });

  it('resolves the in-flight tool block to done in place', () => {
    const start: StreamingPart[] = [
      { type: 'text', text: 'hi' },
      { type: 'tool', label: 'Running bash', state: 'generating' }
    ];
    const parts = applyToolStatus(start, { state: 'done', label: 'Done' });
    expect(parts).toEqual([
      { type: 'text', text: 'hi' },
      { type: 'tool', label: 'Running bash', state: 'done' }
    ]);
  });

  it('marks the in-flight tool block as error with its message', () => {
    const start: StreamingPart[] = [
      { type: 'tool', label: 'img', kind: 'image', state: 'generating' }
    ];
    const parts = applyToolStatus(start, {
      state: 'error',
      label: 'Image generation failed',
      error: 'boom',
      kind: 'image'
    });
    expect(parts).toEqual([
      { type: 'tool', label: 'img', kind: 'image', state: 'error', error: 'boom' }
    ]);
  });

  it('builds a full text→tool→text interleave across sequential events', () => {
    let parts: StreamingPart[] = [];
    parts = appendTextPart(parts, 'Let me make an image. ');
    parts = applyToolStatus(parts, {
      state: 'generating',
      label: 'Generating image',
      kind: 'image'
    });
    parts = applyToolStatus(parts, { state: 'done', label: 'Image ready' });
    parts = appendTextPart(parts, "Here's the summary.");
    expect(parts.map((p) => p.type)).toEqual(['text', 'tool', 'text']);
    expect(parts).toEqual([
      { type: 'text', text: 'Let me make an image. ' },
      { type: 'tool', label: 'Generating image', kind: 'image', state: 'done' },
      { type: 'text', text: "Here's the summary." }
    ]);
  });
});
