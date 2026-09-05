import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Mock } from 'vitest';
import { createConfigFolderChoice } from '../config-folder-choice';
import type { ConfigFolderChoice } from '../config-folder-choice';
import type { EnsureConfigDirResult } from '../../../../shared/ipc-api';

const WS = 'ws-1';

/** Folder creations that are answered by hand, so a choice can be made mid-flight. */
let pendingDirs: Array<(result: EnsureConfigDirResult) => void>;
/** What the settings file holds. The applier must never guess at this itself. */
let saved: string | null;
let writes: Array<string | null>;
let announce: Mock<() => void>;
let reload: Mock<() => Promise<void>>;
let onError: Mock<(message: string) => void>;
let choice: ConfigFolderChoice;

function build(): void {
  pendingDirs = [];
  saved = null;
  writes = [];
  announce = vi.fn();
  reload = vi.fn(async () => {
    await Promise.resolve();
  });
  onError = vi.fn();
  choice = createConfigFolderChoice({
    ensureConfigDir: async () =>
      new Promise<EnsureConfigDirResult>((resolve) => pendingDirs.push(resolve)),
    // Stands in for the main process, which is the only side that can answer
    // "did this change anything" without being a version behind.
    setWorkspaceOverride: async (_id, dir) => {
      await Promise.resolve();
      writes.push(dir);
      const changed = dir !== saved;
      saved = dir;
      return { changed };
    },
    reload,
    announce,
    onError
  });
}

/** Let queued microtasks and the applier's own awaits run. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('createConfigFolderChoice', () => {
  beforeEach(build);

  it('creates the folder before saving the choice', async () => {
    const done = choice.apply(WS, '/configs/a');
    pendingDirs[0]({ ok: true });
    await done;
    expect(writes).toEqual(['/configs/a']);
    expect(saved).toBe('/configs/a');
  });

  it('leaves an inherited workspace inherited when Default interrupts a custom folder', async () => {
    // Inherited -> pending Custom -> Default.
    const first = choice.apply(WS, '/configs/a');
    await choice.apply(WS, null);
    pendingDirs[0]({ ok: true });
    await first;
    await flush();

    expect(saved).toBeNull();
    expect(writes).toEqual([null]);
  });

  it('keeps the original path when an edit is reverted mid-flight', async () => {
    // Custom A -> pending Custom B -> Custom A again.
    saved = '/configs/a';
    const toB = choice.apply(WS, '/configs/b');
    const backToA = choice.apply(WS, '/configs/a');
    pendingDirs[0]({ ok: true });
    pendingDirs[1]({ ok: true });
    await Promise.all([toB, backToA]);
    await flush();

    expect(saved).toBe('/configs/a');
  });

  it('lets the latest choice win when two folder creations answer out of order', async () => {
    const first = choice.apply(WS, '/configs/a');
    const second = choice.apply(WS, '/configs/b');
    // The newer request is served first, then the older one answers late.
    pendingDirs[1]({ ok: true });
    await flush();
    pendingDirs[0]({ ok: true });
    await Promise.all([first, second]);
    await flush();

    expect(saved).toBe('/configs/b');
    expect(writes).toEqual(['/configs/b']);
  });

  it('re-picking the value on screen still writes, because the screen can be behind', async () => {
    // The renderer shows A while a write of B is in flight. Deciding "already
    // saved" from the renderer's copy skipped this write and left the file on
    // B with Settings showing A.
    saved = 'B';
    const done = choice.apply(WS, 'A');
    pendingDirs[0]({ ok: true });
    await done;

    expect(writes).toEqual(['A']);
    expect(saved).toBe('A');
  });

  it('never decides "already saved" from anything it remembers itself', async () => {
    // Picking the same folder twice must still ask, because the settings can
    // move underneath - another window, or a write of its own still in flight.
    // A cache here is exactly how the file ended up on one folder while
    // Settings showed another.
    const first = choice.apply(WS, '/configs/a');
    pendingDirs[0]({ ok: true });
    await first;

    saved = '/configs/b';

    const second = choice.apply(WS, '/configs/a');
    pendingDirs[1]({ ok: true });
    await second;

    expect(writes).toEqual(['/configs/a', '/configs/a']);
    expect(saved).toBe('/configs/a');
  });

  it('says nothing when the choice turns out to change nothing', async () => {
    saved = '/configs/a';
    const done = choice.apply(WS, '/configs/a');
    pendingDirs[0]({ ok: true });
    await done;

    expect(writes).toEqual(['/configs/a']);
    expect(announce).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it('announces a change that did land', async () => {
    const done = choice.apply(WS, '/configs/a');
    pendingDirs[0]({ ok: true });
    await done;

    expect(reload).toHaveBeenCalledTimes(1);
    expect(announce).toHaveBeenCalledTimes(1);
  });

  it('reports a folder it could not create, and writes nothing', async () => {
    const done = choice.apply(WS, '/configs/a');
    pendingDirs[0]({ ok: false, error: 'read-only volume' });
    await done;

    expect(onError).toHaveBeenCalledWith('Could not create /configs/a: read-only volume');
    expect(writes).toEqual([]);
  });

  it('stays quiet about a folder failure the user already moved on from', async () => {
    const first = choice.apply(WS, '/configs/a');
    await choice.apply(WS, null);
    pendingDirs[0]({ ok: false, error: 'read-only volume' });
    await first;

    expect(onError).not.toHaveBeenCalled();
  });

  it('keeps two workspaces independent', async () => {
    const a = choice.apply('ws-a', '/configs/a');
    const b = choice.apply('ws-b', '/configs/b');
    pendingDirs[0]({ ok: true });
    pendingDirs[1]({ ok: true });
    await Promise.all([a, b]);

    expect(writes).toEqual(['/configs/a', '/configs/b']);
  });
});
