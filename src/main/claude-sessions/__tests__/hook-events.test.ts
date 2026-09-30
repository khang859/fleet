import { describe, expect, it } from 'vitest';
import { parseHookEvent } from '../hook-events';

const v1 = {
  session_id: 's1',
  cwd: '/repo',
  event: 'PreToolUse',
  status: 'running_tool',
  pid: 42,
  tty: null,
  tool: 'Bash',
  tool_input: { command: 'ls' },
  tool_use_id: 'tu-1'
};

describe('parseHookEvent', () => {
  it('reads a protocol 1 event, as older hook binaries send it', () => {
    expect(parseHookEvent(JSON.stringify(v1))).toEqual({
      sessionId: 's1',
      cwd: '/repo',
      event: 'PreToolUse',
      status: 'running_tool',
      pid: 42,
      tool: 'Bash',
      toolInput: { command: 'ls' },
      toolUseId: 'tu-1',
      protocol: 1
    });
  });

  it('reads the protocol 2 fields', () => {
    const event = parseHookEvent(
      JSON.stringify({
        ...v1,
        event: 'SessionStart',
        status: 'waiting_for_input',
        pane_id: 'pane-3',
        transcript_path: '/c/projects/-repo/s1.jsonl',
        config_dir: '/c',
        source: 'clear',
        protocol: 2
      })
    );
    expect(event).toMatchObject({
      paneId: 'pane-3',
      transcriptPath: '/c/projects/-repo/s1.jsonl',
      configDir: '/c',
      source: 'clear',
      protocol: 2
    });
  });

  it('drops an optional field of the wrong type instead of the event', () => {
    const event = parseHookEvent(JSON.stringify({ ...v1, pid: 'x', tool_input: [1], pane_id: '' }));
    expect(event).toMatchObject({
      sessionId: 's1',
      pid: undefined,
      toolInput: undefined,
      paneId: undefined
    });
  });

  it.each([
    ['not JSON', '{'],
    ['not an object', '[]'],
    ['a missing session id', JSON.stringify({ ...v1, session_id: undefined })],
    ['an empty session id', JSON.stringify({ ...v1, session_id: '' })],
    ['a missing status', JSON.stringify({ ...v1, status: undefined })]
  ])('rejects %s', (_label, text) => {
    expect(parseHookEvent(text)).toBeNull();
  });
});
