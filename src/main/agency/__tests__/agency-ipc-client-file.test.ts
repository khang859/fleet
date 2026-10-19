import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** The client file handlers: a layer is `you` or a project id, and nothing else gets through. */

const handlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn)
  },
  BrowserWindow: {},
  app: {},
  dialog: {},
  shell: {}
}));

const { registerAgencyIpc } = await import('../agency-ipc');
const { AgencyService } = await import('../index');
const { IPC_CHANNELS } = await import('../../../shared/ipc-channels');
const { REPO } = await import('./fixture');

let dir: string;
let service: InstanceType<typeof AgencyService>;
const emitted: string[] = [];

const call = (channel: string, ...args: unknown[]): unknown =>
  handlers.get(channel)!({ sender: {} }, ...args);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fleet-agency-ipc-'));
  emitted.length = 0;
  service = new AgencyService({
    dbPath: join(dir, 'agency.db'),
    emit: (e) => emitted.push(e.repoId),
    hasModelKey: () => true,
    now: () => new Date(2026, 9, 18, 12).getTime(),
    agencyHome: join(dir, 'home')
  });
  handlers.clear();
  registerAgencyIpc(service);
});

afterEach(() => {
  service.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('client file IPC', () => {
  it('adds, edits and removes a You line, without touching any project snapshot', () => {
    const add = { kind: 'add', name: 'You', text: 'Never push to main.' };
    expect(call(IPC_CHANNELS.AGENCY_CLIENT_FILE_LINE, { layer: 'you', change: add })).toEqual({
      ok: true
    });
    const path = join(dir, 'home', 'you.md');
    expect(readFileSync(path, 'utf8')).toBe(
      '# You\n- Never push to main. (from you, 2026-10-18)\n'
    );

    service.store.preferences.recordUse('you', 'Never push to main.', 7);
    const edit = {
      kind: 'edit',
      index: 0,
      was: 'Never push to main.',
      text: 'Never push to main or master.'
    };
    call(IPC_CHANNELS.AGENCY_CLIENT_FILE_LINE, { layer: 'you', change: edit });
    expect(call(IPC_CHANNELS.AGENCY_CLIENT_FILE, 'you')).toMatchObject({
      path,
      text: '# You\n- Never push to main or master. (from you, 2026-10-18)\n',
      changedOutside: false
    });

    expect(service.store.preferences.useCounts('you')).toEqual(
      new Map([['never push to main or master', 1]])
    );

    const stale = { kind: 'remove', index: 0, was: 'Never push to main.' };
    expect(call(IPC_CHANNELS.AGENCY_CLIENT_FILE_LINE, { layer: 'you', change: stale })).toEqual({
      ok: false,
      reason: 'That line changed since you opened it.'
    });
    const remove = { kind: 'remove', index: 0, was: 'Never push to main or master.' };
    call(IPC_CHANNELS.AGENCY_CLIENT_FILE_LINE, { layer: 'you', change: remove });
    expect(readFileSync(path, 'utf8')).toBe('# You\n');
    expect(emitted).toEqual([]);
  });

  it("writes and keeps a project's file, and tells its snapshot", () => {
    call(IPC_CHANNELS.AGENCY_CLIENT_FILE_WRITE, {
      layer: REPO.repoId,
      text: '# fleet\n- Use pnpm.\n'
    });
    call(IPC_CHANNELS.AGENCY_CLIENT_FILE_KEEP, REPO.repoId);
    expect(service.clientFiles.read(REPO.repoId)).toBe('# fleet\n- Use pnpm.\n');
    expect(emitted).toEqual([REPO.repoId, REPO.repoId]);
  });

  it("undoes an outside change to a project's file, and tells its snapshot", () => {
    call(IPC_CHANNELS.AGENCY_CLIENT_FILE_WRITE, {
      layer: REPO.repoId,
      text: '# fleet\n- Use pnpm.\n'
    });
    rmSync(service.clientFiles.path(REPO.repoId));
    call(IPC_CHANNELS.AGENCY_CLIENT_FILE_UNDO, REPO.repoId);
    expect(service.clientFiles.read(REPO.repoId)).toBe('# fleet\n- Use pnpm.\n');
    expect(emitted).toEqual([REPO.repoId, REPO.repoId]);
  });

  it('refuses a layer that is neither you nor a project id, and an empty line', () => {
    const add = { kind: 'add', name: 'x', text: 'Use pnpm.' };
    expect(() =>
      call(IPC_CHANNELS.AGENCY_CLIENT_FILE_LINE, { layer: '../etc', change: add })
    ).toThrow();
    expect(() => call(IPC_CHANNELS.AGENCY_CLIENT_FILE, '../../x')).toThrow();
    expect(() =>
      call(IPC_CHANNELS.AGENCY_CLIENT_FILE_LINE, { layer: 'you', change: { ...add, text: '  ' } })
    ).toThrow();
  });
});
