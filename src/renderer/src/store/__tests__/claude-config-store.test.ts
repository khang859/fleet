import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useClaudeConfigStore, isDirty } from '../claude-config-store';
import type { ClaudeFileRevision, ClaudeWriteResult } from '../../../../shared/claude-config-types';

const REV = (mtimeMs: number, size: number): ClaudeFileRevision => ({
  exists: true,
  mtimeMs,
  size
});
const ABSENT: ClaudeFileRevision = { exists: false, mtimeMs: 0, size: 0 };

let read: ReturnType<typeof vi.fn>;
let write: ReturnType<typeof vi.fn>;
let resolveLocalRoot: ReturnType<typeof vi.fn>;

function installFleet(): void {
  read = vi.fn();
  read.mockResolvedValue({
    path: '/u/.claude/settings.json',
    text: '{"model":"a"}',
    revision: REV(1000, 13),
    exists: true
  });
  write = vi.fn();
  const ok: ClaudeWriteResult = { ok: true, revision: REV(2000, 20) };
  write.mockResolvedValue(ok);
  resolveLocalRoot = vi.fn();
  resolveLocalRoot.mockResolvedValue({ root: '/repo', rule: 'repositoryRoot' as const });

  (globalThis as unknown as { window: unknown }).window = {
    fleet: { claudeConfig: { read, write, resolveLocalRoot } }
  };
}

function reset(): void {
  useClaudeConfigStore.setState({
    scope: 'user',
    kind: 'settings',
    configDir: '/u/.claude',
    sessionDir: '',
    localSettingsRoot: '',
    localRootRule: 'sessionDirectory',
    sessionDirPinned: false,
    localRootPinned: false,
    documents: {},
    staleOnDisk: {}
  });
}

beforeEach(() => {
  installFleet();
  reset();
});

const store = () => useClaudeConfigStore.getState();
const doc = (path: string) => store().documents[path];

describe('load', () => {
  it('reads a file into a document keyed by its path', async () => {
    await store().load('user', 'settings', '/u/.claude/settings.json');
    expect(doc('/u/.claude/settings.json')?.text).toBe('{"model":"a"}');
    expect(doc('/u/.claude/settings.json')?.exists).toBe(true);
    expect(isDirty(doc('/u/.claude/settings.json'))).toBe(false);
  });

  it('does not replace a dirty document on a background load', async () => {
    const path = '/u/.claude/settings.json';
    await store().load('user', 'settings', path);
    store().edit(path, '{"model":"edited"}');

    read.mockResolvedValueOnce({
      path,
      text: '{"model":"changed on disk"}',
      revision: REV(9999, 30),
      exists: true
    });
    await store().load('user', 'settings', path);

    expect(doc(path)?.text).toBe('{"model":"edited"}');
    expect(isDirty(doc(path))).toBe(true);
  });

  it('replaces a dirty document when the load is forced', async () => {
    const path = '/u/.claude/settings.json';
    await store().load('user', 'settings', path);
    store().edit(path, '{"model":"edited"}');

    read.mockResolvedValueOnce({
      path,
      text: '{"model":"from disk"}',
      revision: REV(9999, 30),
      exists: true
    });
    await store().reload('user', 'settings', path);

    expect(doc(path)?.text).toBe('{"model":"from disk"}');
    expect(isDirty(doc(path))).toBe(false);
  });

  it('leaves a document usable when the read throws', async () => {
    read.mockRejectedValueOnce(new Error('nope'));
    await store().load('user', 'settings', '/u/.claude/settings.json');
    expect(doc('/u/.claude/settings.json')?.loading).toBe(false);
    expect(doc('/u/.claude/settings.json')?.text).toBe('{}');
  });

  it('reads the scope it was given, not whichever scope the page is showing', async () => {
    // Loading all three files for the precedence report happens while one scope
    // is selected; reading `get().scope` here would fetch that one file thrice.
    store().setScope('user');
    await store().load('projectLocal', 'settings', '/repo/.claude/settings.local.json');
    expect(read).toHaveBeenCalledWith(expect.objectContaining({ scope: 'projectLocal' }));
  });

  it('seeds a memory document with empty text, not an empty object', async () => {
    read.mockResolvedValueOnce({
      path: '/u/.claude/CLAUDE.md',
      text: '',
      revision: ABSENT,
      exists: false
    });
    await store().load('user', 'memory', '/u/.claude/CLAUDE.md');
    expect(doc('/u/.claude/CLAUDE.md')?.text).toBe('');
  });
});

describe('edit and dirty tracking', () => {
  it('marks a document dirty and clean again on save', async () => {
    const path = '/u/.claude/settings.json';
    await store().load('user', 'settings', path);
    store().edit(path, '{"model":"b"}');
    expect(isDirty(doc(path))).toBe(true);

    await store().save('user', 'settings', path);
    expect(isDirty(doc(path))).toBe(false);
    expect(doc(path)?.revision).toEqual(REV(2000, 20));
  });

  it('is not dirty when an edit restores the saved text', async () => {
    const path = '/u/.claude/settings.json';
    await store().load('user', 'settings', path);
    store().edit(path, '{"model":"b"}');
    store().edit(path, '{"model":"a"}');
    expect(isDirty(doc(path))).toBe(false);
  });
});

describe('save conflicts', () => {
  it('records a refusal instead of clearing the draft', async () => {
    const path = '/u/.claude/settings.json';
    await store().load('user', 'settings', path);
    store().edit(path, '{"model":"mine"}');

    write.mockResolvedValueOnce({ ok: false, reason: 'modified', revision: REV(5000, 40) });
    await store().save('user', 'settings', path);

    expect(doc(path)?.conflict?.reason).toBe('modified');
    expect(doc(path)?.text).toBe('{"model":"mine"}');
    expect(isDirty(doc(path))).toBe(true);
  });

  it('distinguishes deletion and creation refusals', async () => {
    const path = '/u/.claude/settings.json';
    await store().load('user', 'settings', path);

    write.mockResolvedValueOnce({ ok: false, reason: 'deleted', revision: ABSENT });
    await store().save('user', 'settings', path);
    expect(doc(path)?.conflict?.reason).toBe('deleted');

    write.mockResolvedValueOnce({ ok: false, reason: 'created', revision: REV(1, 1) });
    await store().save('user', 'settings', path);
    expect(doc(path)?.conflict?.reason).toBe('created');
  });

  it('re-reads disk before an overwrite so a stale revision is not reused', async () => {
    const path = '/u/.claude/settings.json';
    await store().load('user', 'settings', path);
    store().edit(path, '{"model":"mine"}');

    read.mockResolvedValueOnce({
      path,
      text: '{"hooks":{}}',
      revision: REV(7777, 60),
      exists: true
    });
    await store().save('user', 'settings', path, { overwrite: true });

    expect(write).toHaveBeenCalledWith(
      expect.objectContaining({ expected: REV(7777, 60), text: '{"model":"mine"}' })
    );
  });

  it('surfaces a discarded hooks edit after a successful save', async () => {
    const path = '/u/.claude/settings.json';
    await store().load('user', 'settings', path);
    write.mockResolvedValueOnce({ ok: true, revision: REV(3000, 30), hooksDiscarded: true });
    await store().save('user', 'settings', path);
    expect(doc(path)?.hooksDiscarded).toBe(true);
  });

  it('clears a notice on the next edit', async () => {
    const path = '/u/.claude/settings.json';
    await store().load('user', 'settings', path);
    write.mockResolvedValueOnce({ ok: false, reason: 'modified', revision: REV(5, 5) });
    await store().save('user', 'settings', path);
    store().edit(path, '{}');
    expect(doc(path)?.conflict).toBeUndefined();
  });
});

describe('directory resolution', () => {
  it('derives the local settings root from the session directory', async () => {
    await store().adoptSessionDir('/repo/packages/api', false);
    expect(store().sessionDir).toBe('/repo/packages/api');
    expect(store().localSettingsRoot).toBe('/repo');
    expect(store().localRootRule).toBe('repositoryRoot');
  });

  it('does not move a pinned session directory on an automatic update', async () => {
    await store().adoptSessionDir('/chosen/by/hand', true);
    await store().adoptSessionDir('/some/other/pane', false);
    expect(store().sessionDir).toBe('/chosen/by/hand');
  });

  it('leaves a pinned local root alone when the session directory changes', async () => {
    store().pinLocalRoot('/my/own/root');
    await store().adoptSessionDir('/repo/packages/api', false);
    expect(store().localSettingsRoot).toBe('/my/own/root');
    expect(resolveLocalRoot).not.toHaveBeenCalled();
  });

  it('falls back to the session directory when resolution throws', async () => {
    resolveLocalRoot.mockRejectedValueOnce(new Error('no git'));
    await store().adoptSessionDir('/plain/folder', false);
    expect(store().localSettingsRoot).toBe('/plain/folder');
    expect(store().localRootRule).toBe('sessionDirectory');
  });

  it('drops a stale resolution that lands after the directory changed again', async () => {
    let release: (v: { root: string; rule: 'repositoryRoot' }) => void = () => {};
    resolveLocalRoot.mockReturnValueOnce(
      new Promise((r) => {
        release = r;
      })
    );
    const slow = store().adoptSessionDir('/first', false);
    await store().adoptSessionDir('/second', false);
    release({ root: '/first-repo', rule: 'repositoryRoot' });
    await slow;

    expect(store().sessionDir).toBe('/second');
    expect(store().localSettingsRoot).toBe('/repo');
  });
});

describe('refreshFromDisk', () => {
  const path = '/u/.claude/settings.json';

  it('adopts the disk content when the document is clean', async () => {
    await store().load('user', 'settings', path);
    read.mockResolvedValueOnce({
      path,
      text: '{"hooks":{"Stop":[]}}',
      revision: REV(4000, 21),
      exists: true
    });
    await store().refreshFromDisk('user', 'settings', path);

    expect(doc(path)?.text).toBe('{"hooks":{"Stop":[]}}');
    expect(isDirty(doc(path))).toBe(false);
    expect(useClaudeConfigStore.getState().staleOnDisk[path]).toBe(false);
  });

  it('keeps a draft and flags the file stale instead', async () => {
    await store().load('user', 'settings', path);
    store().edit(path, '{"model":"mine"}');
    read.mockResolvedValueOnce({
      path,
      text: '{"hooks":{"Stop":[]}}',
      revision: REV(4000, 21),
      exists: true
    });
    await store().refreshFromDisk('user', 'settings', path);

    expect(doc(path)?.text).toBe('{"model":"mine"}');
    expect(useClaudeConfigStore.getState().staleOnDisk[path]).toBe(true);
  });

  it('does nothing when the disk content has not moved', async () => {
    await store().load('user', 'settings', path);
    await store().refreshFromDisk('user', 'settings', path);
    expect(useClaudeConfigStore.getState().staleOnDisk[path]).toBeUndefined();
  });

  it('clears the stale flag once the draft is saved', async () => {
    await store().load('user', 'settings', path);
    store().edit(path, '{"model":"mine"}');
    read.mockResolvedValueOnce({ path, text: '{"a":1}', revision: REV(4000, 7), exists: true });
    await store().refreshFromDisk('user', 'settings', path);
    expect(useClaudeConfigStore.getState().staleOnDisk[path]).toBe(true);

    await store().save('user', 'settings', path);
    expect(useClaudeConfigStore.getState().staleOnDisk[path]).toBe(false);
  });
});

describe('surviving navigation', () => {
  it('keeps drafts and pinned directories when the section unmounts', async () => {
    const path = '/u/.claude/settings.json';
    await store().load('user', 'settings', path);
    store().edit(path, '{"model":"work in progress"}');
    await store().adoptSessionDir('/chosen', true);

    // A remount reads the same module-level store; nothing is re-initialised.
    const afterRemount = useClaudeConfigStore.getState();

    expect(afterRemount.documents[path]?.text).toBe('{"model":"work in progress"}');
    expect(isDirty(afterRemount.documents[path])).toBe(true);
    expect(afterRemount.sessionDir).toBe('/chosen');
    expect(afterRemount.sessionDirPinned).toBe(true);
  });

  it('keeps each scope draft separate, and shares one document per path', async () => {
    const userPath = '/u/.claude/settings.json';
    const projectPath = '/repo/.claude/settings.json';
    await store().load('user', 'settings', userPath);
    store().edit(userPath, '{"model":"user draft"}');

    read.mockResolvedValueOnce({
      path: projectPath,
      text: '{"model":"project"}',
      revision: REV(1, 1),
      exists: true
    });
    await store().load('project', 'settings', projectPath);
    store().edit(projectPath, '{"model":"project draft"}');

    expect(doc(userPath)?.text).toBe('{"model":"user draft"}');
    expect(doc(projectPath)?.text).toBe('{"model":"project draft"}');

    // A second scope resolving to the same path finds the same document, not a
    // second one that would diverge from it.
    await store().load('project', 'settings', projectPath);
    expect(doc(projectPath)?.text).toBe('{"model":"project draft"}');
  });
});

describe('load while the user is typing', () => {
  beforeEach(() => {
    installFleet();
    reset();
  });

  it('keeps an edit made while the read was in flight', async () => {
    const path = '/u/.claude/settings.json';
    await useClaudeConfigStore.getState().load('user', 'settings', path);

    let release: (value: unknown) => void = () => {};
    read.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      })
    );
    const pending = useClaudeConfigStore.getState().load('user', 'settings', path);

    useClaudeConfigStore.getState().edit(path, '{"model":"mine"}');
    release({ path, text: '{"model":"fromDisk"}', revision: REV(3000, 21), exists: true });
    await pending;

    const doc = useClaudeConfigStore.getState().documents[path];
    expect(doc?.text).toBe('{"model":"mine"}');
    expect(isDirty(doc)).toBe(true);
    expect(useClaudeConfigStore.getState().staleOnDisk[path]).toBe(true);
  });

  it('keeps the old revision when disk moved on, so the next save is refused', async () => {
    const path = '/u/.claude/settings.json';
    await useClaudeConfigStore.getState().load('user', 'settings', path);

    let release: (value: unknown) => void = () => {};
    read.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      })
    );
    const pending = useClaudeConfigStore.getState().load('user', 'settings', path);

    useClaudeConfigStore.getState().edit(path, '{"model":"mine"}');
    release({ path, text: '{"model":"someoneElse"}', revision: REV(3000, 21), exists: true });
    await pending;

    // Adopting REV(3000, 21) here would hand the next ordinary save a lock that
    // matches disk, and the save would overwrite the change nobody has seen.
    expect(useClaudeConfigStore.getState().documents[path]?.revision).toEqual(REV(1000, 13));

    await useClaudeConfigStore.getState().save('user', 'settings', path);
    expect(write.mock.calls[0][0].expected).toEqual(REV(1000, 13));
  });

  it('takes the new revision when disk still matches the draft baseline', async () => {
    const path = '/u/.claude/settings.json';
    await useClaudeConfigStore.getState().load('user', 'settings', path);

    let release: (value: unknown) => void = () => {};
    read.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      })
    );
    const pending = useClaudeConfigStore.getState().load('user', 'settings', path);

    useClaudeConfigStore.getState().edit(path, '{"model":"mine"}');
    // Same text, fresh stat: a touch, not an edit. Nothing to protect.
    release({ path, text: '{"model":"a"}', revision: REV(3000, 13), exists: true });
    await pending;

    expect(useClaudeConfigStore.getState().documents[path]?.revision).toEqual(REV(3000, 13));
    expect(useClaudeConfigStore.getState().staleOnDisk[path]).toBeUndefined();
  });

  it('lets a forced reload take the disk version anyway', async () => {
    const path = '/u/.claude/settings.json';
    await useClaudeConfigStore.getState().load('user', 'settings', path);

    let release: (value: unknown) => void = () => {};
    read.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      })
    );
    const pending = useClaudeConfigStore.getState().load('user', 'settings', path, { force: true });

    useClaudeConfigStore.getState().edit(path, '{"model":"mine"}');
    release({ path, text: '{"model":"fromDisk"}', revision: REV(3000, 21), exists: true });
    await pending;

    const doc = useClaudeConfigStore.getState().documents[path];
    expect(doc?.text).toBe('{"model":"fromDisk"}');
    expect(isDirty(doc)).toBe(false);
  });
});
