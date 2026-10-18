import { describe, expect, it } from 'vitest';
import { parseHookEvent } from '../hook-events';
import { hashPrompt } from '../registry';

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
      runtime: 'claude',
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

  it('reads the prompt hash of a protocol 3 UserPromptSubmit', () => {
    const hash = '6f89735c79e3511775b5bcaccc42af7c104e2765fad1562204beddd44b8cee94';
    const event = parseHookEvent(
      JSON.stringify({ ...v1, event: 'UserPromptSubmit', prompt_sha256: hash, protocol: 3 })
    );
    expect(event).toMatchObject({ promptHash: hash, protocol: 3 });
    // The Go hook's test checks the same value for the same text.
    expect(hashPrompt('[admiral] Build the toggle.\nKeep it small.')).toBe(hash);
    expect(
      parseHookEvent(JSON.stringify({ ...v1, prompt_sha256: 'not a hash' }))?.promptHash
    ).toBeUndefined();
  });

  it('reads the runtime and database of a protocol 4 eva event', () => {
    const event = parseHookEvent(
      JSON.stringify({
        ...v1,
        tool: 'bash',
        runtime: 'eva',
        db_path: '/home/u/.eva/sessions.db',
        protocol: 4
      })
    );
    expect(event).toMatchObject({
      runtime: 'eva',
      dbPath: '/home/u/.eva/sessions.db',
      protocol: 4
    });
    expect(parseHookEvent(JSON.stringify({ ...v1, runtime: 'codex' }))?.runtime).toBe('claude');
  });

  it('reads the API error of a StopFailure', () => {
    const event = parseHookEvent(
      JSON.stringify({
        ...v1,
        event: 'StopFailure',
        status: 'api_error',
        error: 'rate_limit',
        error_details: '429 Too Many Requests',
        protocol: 2
      })
    );
    expect(event).toMatchObject({ error: 'rate_limit', errorDetails: '429 Too Many Requests' });
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
