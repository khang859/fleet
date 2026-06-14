import { describe, it, expect } from 'vitest';
import {
  detectIntent,
  buildContextLine,
  composeAssistPrompt,
  buildAssistArgs,
  parseRuneSessionId,
  parseLatestToolStep,
  describeRuneStep,
  lastAssistantText,
  extractChangedFiles,
  changedLineRange,
  clampOverlayPosition,
  ASK_PREAMBLE
} from '../rune-assist';
import type { TranscriptMessage } from '../sessions';

describe('detectIntent', () => {
  it('classifies leading imperatives as edit', () => {
    expect(detectIntent('finish this function')).toBe('edit');
    expect(detectIntent('Refactor the loop')).toBe('edit');
    expect(detectIntent('  add a null guard')).toBe('edit');
  });
  it('classifies questions/everything else as ask', () => {
    expect(detectIntent('what does this do?')).toBe('ask');
    expect(detectIntent('where is validateToken used')).toBe('ask');
    expect(detectIntent('')).toBe('ask');
  });
  it('treats a trailing question mark as ask even with a leading imperative', () => {
    expect(detectIntent('Update the docs?')).toBe('ask');
    expect(detectIntent('add a guard?  ')).toBe('ask');
  });
});

describe('buildContextLine', () => {
  it('renders a selection range', () => {
    expect(buildContextLine('src/auth.ts', { fromLine: 11, toLine: 14 })).toBe(
      '[context: file src/auth.ts, lines 11-14 selected]'
    );
  });
  it('renders a single cursor line when from === to', () => {
    expect(buildContextLine('src/auth.ts', { fromLine: 12, toLine: 12 })).toBe(
      '[context: file src/auth.ts, line 12]'
    );
  });
  it('renders file only when no selection', () => {
    expect(buildContextLine('src/auth.ts', undefined)).toBe('[context: file src/auth.ts]');
  });
});

describe('composeAssistPrompt', () => {
  it('prepends the read-only preamble in ask mode', () => {
    const out = composeAssistPrompt('ask', '[context: file a.ts]', 'what is this');
    expect(out.startsWith(ASK_PREAMBLE)).toBe(true);
    expect(out).toContain('[context: file a.ts]');
    expect(out).toContain('what is this');
    expect(out).toBe(`${ASK_PREAMBLE}\n\n[context: file a.ts]\n\nwhat is this`);
  });
  it('omits the preamble in edit mode', () => {
    const out = composeAssistPrompt('edit', '[context: file a.ts]', 'finish it');
    expect(out.startsWith(ASK_PREAMBLE)).toBe(false);
    expect(out).toBe('[context: file a.ts]\n\nfinish it');
  });
});

describe('buildAssistArgs', () => {
  it('builds prompt-only args on the first turn', () => {
    expect(buildAssistArgs('hello', null)).toEqual(['--prompt', 'hello']);
  });
  it('appends --resume when a session id exists', () => {
    expect(buildAssistArgs('hello', 'sess-1')).toEqual(['--prompt', 'hello', '--resume', 'sess-1']);
  });
});

describe('parseRuneSessionId', () => {
  it('extracts the id from a session-id line', () => {
    expect(parseRuneSessionId('blah\nsession-id: abc_DEF-123\nmore')).toBe('abc_DEF-123');
  });
  it('returns null when absent', () => {
    expect(parseRuneSessionId('no id here')).toBeNull();
  });
});

describe('parseLatestToolStep', () => {
  it('returns the last tool marker in the stream', () => {
    const out =
      'session-id: x\n[tool: list_files]\n[done: 16197 bytes]\n[tool: read]\n[done: 9 bytes]';
    expect(parseLatestToolStep(out)).toBe('read');
  });
  it('returns null when there are no tool markers', () => {
    expect(parseLatestToolStep('session-id: x\nOK')).toBeNull();
  });
});

describe('describeRuneStep', () => {
  it('humanizes known tool names', () => {
    expect(describeRuneStep('read')).toBe('reading…');
    expect(describeRuneStep('edit')).toBe('editing…');
    expect(describeRuneStep('search_files')).toBe('searching…');
  });
  it('falls back to the raw name with an ellipsis', () => {
    expect(describeRuneStep('mystery_tool')).toBe('mystery_tool…');
  });
});

describe('lastAssistantText', () => {
  it('returns the concatenated text of the last assistant message', () => {
    const messages: TranscriptMessage[] = [
      { role: 'user', blocks: [{ type: 'text', text: 'q' }] },
      { role: 'assistant', blocks: [{ type: 'text', text: 'first' }] },
      { role: 'tool', blocks: [{ type: 'tool_result', output: 'x' }] },
      {
        role: 'assistant',
        blocks: [
          { type: 'text', text: 'final ' },
          { type: 'text', text: 'answer' }
        ]
      }
    ];
    expect(lastAssistantText(messages)).toBe('final answer');
  });
  it('returns empty string when there is no assistant text', () => {
    expect(lastAssistantText([{ role: 'user', blocks: [{ type: 'text', text: 'q' }] }])).toBe('');
  });
});

describe('extractChangedFiles', () => {
  it('collects file paths from write-like tool calls', () => {
    const messages: TranscriptMessage[] = [
      {
        role: 'assistant',
        blocks: [
          {
            type: 'tool_use',
            name: 'write_file',
            argsPreview: JSON.stringify({ path: 'src/a.ts' })
          },
          {
            type: 'tool_use',
            name: 'edit_file',
            argsPreview: JSON.stringify({ file_path: 'src/b.ts' })
          },
          { type: 'tool_use', name: 'read_file', argsPreview: JSON.stringify({ path: 'src/c.ts' }) }
        ]
      }
    ];
    expect(extractChangedFiles(messages)).toEqual(['src/a.ts', 'src/b.ts']);
  });
  it('dedupes and ignores unparseable args', () => {
    const messages: TranscriptMessage[] = [
      {
        role: 'assistant',
        blocks: [
          {
            type: 'tool_use',
            name: 'write_file',
            argsPreview: JSON.stringify({ path: 'src/a.ts' })
          },
          {
            type: 'tool_use',
            name: 'write_file',
            argsPreview: JSON.stringify({ path: 'src/a.ts' })
          },
          { type: 'tool_use', name: 'write_file', argsPreview: 'not json' }
        ]
      }
    ];
    expect(extractChangedFiles(messages)).toEqual(['src/a.ts']);
  });
});

describe('changedLineRange', () => {
  it('returns the 1-based inclusive range of changed lines', () => {
    const before = 'a\nb\nc\nd';
    const after = 'a\nB\nC\nd';
    expect(changedLineRange(before, after)).toEqual({ fromLine: 2, toLine: 3 });
  });
  it('handles added lines', () => {
    expect(changedLineRange('a\nb', 'a\nx\nb')).toEqual({ fromLine: 2, toLine: 2 });
  });
  it('returns null when identical', () => {
    expect(changedLineRange('a\nb', 'a\nb')).toBeNull();
  });
  it('clamps trailing deletions to the new line count', () => {
    expect(changedLineRange('a\nb\nc', 'a\nb')).toEqual({ fromLine: 2, toLine: 2 });
  });
  it('handles leading deletions', () => {
    expect(changedLineRange('a\nb\nc', 'b\nc')).toEqual({ fromLine: 1, toLine: 1 });
  });
});

describe('clampOverlayPosition', () => {
  const base = { layerWidth: 800, layerHeight: 600, boxWidth: 320, boxHeight: 120, pad: 8 };

  it('leaves an in-bounds position untouched', () => {
    expect(clampOverlayPosition({ ...base, rawTop: 100, rawLeft: 100 })).toEqual({
      top: 100,
      left: 100
    });
  });

  it('clamps a position past the right/bottom edge back inside', () => {
    // maxLeft = 800 - 320 - 8 = 472; maxTop = 600 - 120 - 8 = 472
    expect(clampOverlayPosition({ ...base, rawTop: 5000, rawLeft: 5000 })).toEqual({
      top: 472,
      left: 472
    });
  });

  it('clamps a negative position to the padding', () => {
    expect(clampOverlayPosition({ ...base, rawTop: -50, rawLeft: -50 })).toEqual({
      top: 8,
      left: 8
    });
  });

  it('pins to pad when the box is larger than the layer', () => {
    expect(
      clampOverlayPosition({
        rawTop: 300,
        rawLeft: 300,
        layerWidth: 100,
        layerHeight: 100,
        boxWidth: 320,
        boxHeight: 120,
        pad: 8
      })
    ).toEqual({ top: 8, left: 8 });
  });
});
