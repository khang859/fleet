import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { RemoteDirEntry, RemoteHost } from '../../../../shared/remote-ssh-types';

const remoteSsh = {
  list: vi.fn(),
  stat: vi.fn(),
  mkdir: vi.fn(),
  rename: vi.fn(),
  remove: vi.fn()
};

const HOST: RemoteHost = { id: 'h', label: 'box', host: 'box.example.net', user: 'k' };
const PANE_ID = 'pane-1';

function entry(partial: Partial<RemoteDirEntry> & { name: string }): RemoteDirEntry {
  return {
    path: `/home/k/${partial.name}`,
    kind: 'file',
    size: 0,
    mtimeMs: 0,
    ...partial
  };
}

beforeEach(() => {
  for (const fn of Object.values(remoteSsh)) fn.mockReset();
  remoteSsh.list.mockResolvedValue({
    success: true,
    data: { entries: [], resolvedPath: '/home/k' }
  });
  // Nothing at the destination unless a test says otherwise.
  remoteSsh.stat.mockResolvedValue({ success: true, data: null });
  (globalThis as unknown as { window: unknown }).window = { fleet: { remoteSsh } };
});

/** A store with one open pane sitting on /home/k. */
async function storeWithPane() {
  const mod = await import('../remote-ssh-store');
  mod.useRemoteSshStore.setState({
    panes: {
      [PANE_ID]: {
        host: HOST,
        cwd: '/home/k',
        entries: [],
        loading: false,
        error: null,
        connection: 'connected',
        sortKey: 'name',
        sortDir: 'asc',
        view: 'list',
        focused: null,
        history: ['/home/k'],
        historyIndex: 0
      }
    }
  });
  return mod.useRemoteSshStore;
}

describe('createFolder', () => {
  it('creates the folder inside the current directory and focuses it', async () => {
    remoteSsh.mkdir.mockResolvedValue({ success: true, data: undefined });
    const store = await storeWithPane();

    expect(await store.getState().createFolder(PANE_ID, 'notes')).toBeNull();
    expect(remoteSsh.mkdir).toHaveBeenCalledWith(HOST, '/home/k/notes');
    expect(store.getState().panes[PANE_ID]?.focused).toBe('/home/k/notes');
  });

  it('explains a duplicate instead of passing sftp\'s bare "Failure" through', async () => {
    remoteSsh.stat.mockResolvedValue({ success: true, data: entry({ name: 'notes' }) });
    const store = await storeWithPane();

    expect(await store.getState().createFolder(PANE_ID, 'notes')).toMatch(/already exists/);
    expect(remoteSsh.mkdir).not.toHaveBeenCalled();
  });

  it('returns the error and leaves the listing alone when mkdir fails', async () => {
    remoteSsh.mkdir.mockResolvedValue({ success: false, error: 'Permission denied' });
    const store = await storeWithPane();

    expect(await store.getState().createFolder(PANE_ID, 'notes')).toBe('Permission denied');
    expect(remoteSsh.list).not.toHaveBeenCalled();
  });
});

describe('renameEntry', () => {
  it('renames within the same directory', async () => {
    remoteSsh.stat.mockResolvedValue({ success: true, data: null });
    remoteSsh.rename.mockResolvedValue({ success: true, data: undefined });
    const store = await storeWithPane();

    expect(
      await store.getState().renameEntry(PANE_ID, entry({ name: 'a.txt' }), 'b.txt')
    ).toBeNull();
    expect(remoteSsh.rename).toHaveBeenCalledWith(HOST, '/home/k/a.txt', '/home/k/b.txt');
  });

  it('refuses to overwrite an existing entry', async () => {
    // posix-rename would replace the target without a word, so the guard is the
    // only thing standing between a rename and silent data loss.
    remoteSsh.stat.mockResolvedValue({ success: true, data: entry({ name: 'b.txt' }) });
    const store = await storeWithPane();

    const error = await store.getState().renameEntry(PANE_ID, entry({ name: 'a.txt' }), 'b.txt');
    expect(error).toMatch(/already exists/);
    expect(remoteSsh.rename).not.toHaveBeenCalled();
  });

  it('is a no-op when the name is unchanged', async () => {
    const store = await storeWithPane();

    expect(
      await store.getState().renameEntry(PANE_ID, entry({ name: 'a.txt' }), 'a.txt')
    ).toBeNull();
    expect(remoteSsh.stat).not.toHaveBeenCalled();
    expect(remoteSsh.rename).not.toHaveBeenCalled();
  });
});

describe('removeEntry', () => {
  it('deletes a directory recursively', async () => {
    remoteSsh.remove.mockResolvedValue({ success: true, data: undefined });
    const store = await storeWithPane();

    await store.getState().removeEntry(PANE_ID, entry({ name: 'src', kind: 'dir' }));
    expect(remoteSsh.remove).toHaveBeenCalledWith(HOST, '/home/k/src', true);
  });

  it('unlinks a symlink rather than following it', async () => {
    remoteSsh.remove.mockResolvedValue({ success: true, data: undefined });
    const store = await storeWithPane();

    await store.getState().removeEntry(PANE_ID, entry({ name: 'link', kind: 'symlink' }));
    expect(remoteSsh.remove).toHaveBeenCalledWith(HOST, '/home/k/link', false);
  });

  it('surfaces the failure instead of refreshing', async () => {
    remoteSsh.remove.mockResolvedValue({ success: false, error: 'Directory not empty' });
    const store = await storeWithPane();

    expect(await store.getState().removeEntry(PANE_ID, entry({ name: 'a.txt' }))).toBe(
      'Directory not empty'
    );
    expect(remoteSsh.list).not.toHaveBeenCalled();
  });
});
