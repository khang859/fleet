import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FolderWatcher } from '../folder-watcher';

describe('FolderWatcher', () => {
  let dir: string;
  let flows: string;
  let onChange: ReturnType<typeof vi.fn<() => void>>;
  let watcher: FolderWatcher;

  /** The same shape the service uses: the folder, and each parent that can hold it. */
  function watchFlows(): void {
    watcher.watch([
      { dir: dirname(dirname(flows)), only: '.fleet' },
      { dir: dirname(flows), only: 'workflows' },
      { dir: flows }
    ]);
  }

  /** A new watcher needs a moment to start, so this repeats the change until it hears. */
  async function hears(change: () => void): Promise<void> {
    await vi.waitFor(
      () => {
        change();
        expect(onChange).toHaveBeenCalled();
      },
      { timeout: 3000, interval: 100 }
    );
    onChange.mockClear();
  }

  const writeFile = (): void => writeFileSync(join(flows, 'one.toml'), 'text');

  const remakeFolder = (): void => {
    rmSync(join(dir, '.fleet'), { recursive: true, force: true });
    mkdirSync(flows, { recursive: true });
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fleet-folder-watcher-'));
    flows = join(dir, '.fleet', 'workflows');
    onChange = vi.fn<() => void>();
    watcher = new FolderWatcher(onChange, 10);
  });

  afterEach(() => {
    watcher.dispose();
    rmSync(dir, { recursive: true, force: true });
  });

  it('hears a new file', async () => {
    mkdirSync(flows, { recursive: true });
    watchFlows();

    await hears(writeFile);
  });

  it('hears a folder that is made later, and then the files in it', async () => {
    watchFlows();

    await hears(remakeFolder);

    await hears(writeFile);
  });

  it('hears a file in a folder that is deleted and made again', async () => {
    mkdirSync(flows, { recursive: true });
    watchFlows();

    await hears(remakeFolder);

    await hears(writeFile);
  });

  it('ignores other names in a parent folder', async () => {
    watcher.watch([{ dir, only: '.fleet' }]);

    writeFileSync(join(dir, 'other.txt'), 'text');
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(onChange).not.toHaveBeenCalled();
  });

  it('says nothing after it is disposed', async () => {
    mkdirSync(flows, { recursive: true });
    watchFlows();

    writeFileSync(join(flows, 'one.toml'), 'text');
    watcher.dispose();
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(onChange).not.toHaveBeenCalled();
  });
});
