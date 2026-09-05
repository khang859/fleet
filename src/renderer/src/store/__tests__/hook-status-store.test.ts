import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useHookStatusStore } from '../hook-status-store';

type Deferred = { resolve: (installed: boolean) => void; reject: (err: Error) => void };

let pending: Map<string, Deferred[]>;
let installTo: ReturnType<typeof vi.fn>;
let uninstallFrom: ReturnType<typeof vi.fn>;

/**
 * A hand-held `window.fleet.copilot`, so each check can be answered at the
 * moment the test chooses - which is the only way to pin down what happens
 * while an answer is still outstanding, or when an old one arrives late.
 */
function installFleet(): void {
  pending = new Map();
  installTo = vi.fn(async (): Promise<boolean> => {
    await flush();
    return true;
  });
  uninstallFrom = vi.fn(async (): Promise<boolean> => {
    await flush();
    return true;
  });
  const copilot = {
    hookStatusFor: async (folder: string): Promise<boolean> => {
      const installed = await new Promise<boolean>((resolve, reject) => {
        const queue = pending.get(folder) ?? [];
        queue.push({ resolve, reject });
        pending.set(folder, queue);
      });
      return installed;
    },
    installHooksTo: installTo,
    uninstallHooksFrom: uninstallFrom
  };
  (globalThis as unknown as { window: unknown }).window = { fleet: { copilot } };
}

/** Answer the nth outstanding check for a folder (0 = the oldest). */
function answer(folder: string, index: number, installed: boolean): void {
  pending.get(folder)?.[index].resolve(installed);
}

/** Let every queued microtask and the store's own `.then` chain run. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function stateOf(folder: string): string | undefined {
  return useHookStatusStore.getState().byFolder[folder]?.state;
}

const FOLDER = '/shared/.claude';

describe('useHookStatusStore', () => {
  beforeEach(() => {
    installFleet();
    useHookStatusStore.setState({ byFolder: {} });
  });

  it('reports checking until an answer arrives', () => {
    useHookStatusStore.getState().check(FOLDER);
    expect(stateOf(FOLDER)).toBe('checking');
  });

  it('keeps a failed check separate from "not installed"', async () => {
    useHookStatusStore.getState().check(FOLDER);
    pending.get(FOLDER)?.[0].reject(new Error('permission denied'));
    await flush();
    expect(stateOf(FOLDER)).toBe('error');
  });

  it('gives every consumer of one folder the same answer', async () => {
    // Two workspaces sharing a folder are two readers of one entry, so there is
    // no second status that could disagree.
    useHookStatusStore.getState().check(FOLDER);
    answer(FOLDER, 0, true);
    await flush();
    expect(stateOf(FOLDER)).toBe('installed');
  });

  it('keeps two folders independent', async () => {
    const other = '/work/.claude';
    useHookStatusStore.getState().check(FOLDER);
    useHookStatusStore.getState().check(other);
    answer(FOLDER, 0, true);
    answer(other, 0, false);
    await flush();
    expect(stateOf(FOLDER)).toBe('installed');
    expect(stateOf(other)).toBe('missing');
  });

  it('drops a stale answer that lands after a newer check', async () => {
    useHookStatusStore.getState().check(FOLDER);
    useHookStatusStore.getState().check(FOLDER);
    // The newer check answers first, then the older one arrives late.
    answer(FOLDER, 1, false);
    await flush();
    answer(FOLDER, 0, true);
    await flush();
    expect(stateOf(FOLDER)).toBe('missing');
  });

  it('re-checks after installing rather than assuming success', async () => {
    installTo.mockRejectedValueOnce(new Error('read-only volume'));
    const done = useHookStatusStore.getState().install(FOLDER);
    await done;
    // The failed install left a fresh check outstanding, not a false "installed".
    expect(stateOf(FOLDER)).toBe('checking');
    answer(FOLDER, 0, false);
    await flush();
    expect(stateOf(FOLDER)).toBe('missing');
  });

  it('refuses a second action while one is already running', async () => {
    const first = useHookStatusStore.getState().install(FOLDER);
    await useHookStatusStore.getState().install(FOLDER);
    await first;
    expect(installTo).toHaveBeenCalledTimes(1);
  });
});
