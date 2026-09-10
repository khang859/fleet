import { describe, it, expect } from 'vitest';
import {
  isFleetHookCommand,
  isFleetHookEntry,
  readHooks,
  mergeHooks,
  hooksDiffer,
  type ClaudeHookEntry
} from '../claude-hooks';

const fleet = (matcher?: string): ClaudeHookEntry => ({
  ...(matcher !== undefined ? { matcher } : {}),
  hooks: [{ type: 'command', command: '/u/.claude/hooks/fleet-copilot-darwin-arm64' }]
});

const mine = (command: string, matcher?: string): ClaudeHookEntry => ({
  ...(matcher !== undefined ? { matcher } : {}),
  hooks: [{ type: 'command', command }]
});

describe('isFleetHookCommand', () => {
  it.each([
    '/Users/k/.claude/hooks/fleet-copilot-darwin-arm64',
    '/Users/k/.claude/hooks/fleet-copilot-linux-amd64',
    'C:\\Users\\k\\.claude\\hooks\\fleet-copilot-windows-amd64.exe',
    '/Users/k/.claude/hooks/fleet-copilot.py'
  ])('recognises %s', (command) => {
    expect(isFleetHookCommand(command)).toBe(true);
  });

  it('recognises the binary when arguments follow it', () => {
    expect(isFleetHookCommand('/u/.claude/hooks/fleet-copilot-darwin-arm64 --verbose')).toBe(true);
  });

  it.each([
    '/u/.claude/hooks/rtk-rewrite.sh',
    'prettier --write',
    // Mentions the path but does not run it - the user still owns this hook.
    'echo running /u/.claude/hooks/fleet-copilot-darwin-arm64',
    '/u/.claude/hooks/fleet-copilot-wrapper.sh'
  ])('leaves %s to the user', (command) => {
    expect(isFleetHookCommand(command)).toBe(false);
  });
});

describe('isFleetHookEntry', () => {
  it('claims an entry that mixes a Fleet command with a user one', () => {
    const entry: ClaudeHookEntry = {
      matcher: '*',
      hooks: [
        { type: 'command', command: '/u/.claude/hooks/mine.sh' },
        { type: 'command', command: '/u/.claude/hooks/fleet-copilot-darwin-arm64' }
      ]
    };
    expect(isFleetHookEntry(entry)).toBe(true);
  });

  it('leaves an entry with no Fleet command alone', () => {
    expect(isFleetHookEntry(mine('/u/.claude/hooks/mine.sh'))).toBe(false);
  });
});

describe('readHooks', () => {
  it('returns an empty block when the key is missing or not an object', () => {
    expect(readHooks({})).toEqual({});
    expect(readHooks({ hooks: 'nope' })).toEqual({});
    expect(readHooks({ hooks: [1, 2] })).toEqual({});
  });

  it('keeps every field an entry carries, including timeout', () => {
    const document = {
      hooks: {
        PermissionRequest: [
          { matcher: '*', hooks: [{ type: 'command', command: '/x', timeout: 86400 }] }
        ]
      }
    };
    expect(readHooks(document).PermissionRequest[0]).toEqual({
      matcher: '*',
      hooks: [{ type: 'command', command: '/x', timeout: 86400 }]
    });
  });

  it('skips malformed entries rather than throwing', () => {
    const document = { hooks: { Stop: ['nope', 42, { hooks: 'also nope' }] } };
    expect(readHooks(document).Stop).toEqual([{ hooks: [] }]);
  });
});

describe('mergeHooks', () => {
  it('takes Fleet entries from disk and user entries from the document', () => {
    const incoming = { Stop: [mine('/u/a.sh')] };
    const onDisk = { Stop: [fleet()] };
    expect(mergeHooks(incoming, onDisk)).toEqual({ Stop: [fleet(), mine('/u/a.sh')] });
  });

  it('restores a Fleet entry the document deleted', () => {
    expect(mergeHooks({ Stop: [] }, { Stop: [fleet()] })).toEqual({ Stop: [fleet()] });
  });

  it('refuses a Fleet entry the document invented', () => {
    expect(mergeHooks({ Stop: [fleet()] }, {})).toEqual({});
  });

  it('removes a user entry the document deleted', () => {
    const onDisk = { Stop: [fleet(), mine('/u/gone.sh')] };
    expect(mergeHooks({ Stop: [fleet()] }, onDisk)).toEqual({ Stop: [fleet()] });
  });

  it('adds an event that exists only in the document', () => {
    const merged = mergeHooks({ PreToolUse: [mine('/u/a.sh', 'Bash')] }, { Stop: [fleet()] });
    expect(merged).toEqual({ PreToolUse: [mine('/u/a.sh', 'Bash')], Stop: [fleet()] });
  });

  it('drops an event left with no entries at all', () => {
    expect(mergeHooks({ Stop: [] }, { Stop: [mine('/u/gone.sh')] })).toEqual({});
  });

  it('puts Fleet entries first so the block matches what the installer writes', () => {
    const merged = mergeHooks({ Stop: [mine('/u/a.sh'), mine('/u/b.sh')] }, { Stop: [fleet()] });
    expect(merged.Stop).toEqual([fleet(), mine('/u/a.sh'), mine('/u/b.sh')]);
  });
});

describe('hooksDiffer', () => {
  it('is false when the merge left the document alone', () => {
    const incoming = { Stop: [fleet(), mine('/u/a.sh')] };
    expect(hooksDiffer(incoming, mergeHooks(incoming, { Stop: [fleet()] }))).toBe(false);
  });

  it('is true when the merge overruled the document', () => {
    const incoming = { Stop: [mine('/u/a.sh')] };
    expect(hooksDiffer(incoming, mergeHooks(incoming, { Stop: [fleet()] }))).toBe(true);
  });
});
