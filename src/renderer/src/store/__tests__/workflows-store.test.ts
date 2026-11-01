import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowEntries, WorkflowEntry } from '../../../../shared/workflows';
import type * as WorkflowsStore from '../workflows-store';

type EntriesListener = (reply: WorkflowEntries) => void;

const list = vi.fn<(path: string) => Promise<WorkflowEntry[]>>();
const shown = vi.fn<(text: string) => void>();
let pushEntries: EntriesListener = () => undefined;

vi.mock('../../hooks/use-terminal', () => ({
  clearCreatedPty: () => undefined,
  markPtyCreated: () => undefined
}));
vi.mock('../workspace-store', () => ({ hasRunTab: () => false, useWorkspaceStore: {} }));
vi.mock('../toast-store', () => ({ useToastStore: { getState: () => ({ show: shown }) } }));

vi.hoisted(() => {
  const call = async (method: string, ...args: unknown[]): Promise<unknown> => {
    if (method === 'list') return (globalThis as Hooks).listEntries(args[0] as string);
    if (method === 'projects') return (args[0] as string[]).map((path) => ({ path }));
    return method === 'tabs' ? [] : { runs: [], rules: [], away: [], notices: [] };
  };
  (globalThis as unknown as { window: unknown }).window = {
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    fleet: {
      workflows: {
        call,
        onState: () => () => undefined,
        onTab: () => () => undefined,
        onEntries: (listener: EntriesListener) => {
          (globalThis as Hooks).onEntriesListener(listener);
          return () => undefined;
        }
      }
    }
  };
});

type Hooks = typeof globalThis & {
  listEntries: (path: string) => Promise<WorkflowEntry[]>;
  onEntriesListener: (listener: EntriesListener) => void;
};

function entry(id: string): WorkflowEntry {
  return { id } as WorkflowEntry;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('workflows store', () => {
  beforeEach(() => {
    list.mockReset().mockResolvedValue([]);
    shown.mockReset();
    (globalThis as Hooks).listEntries = list;
    (globalThis as Hooks).onEntriesListener = (listener) => {
      pushEntries = listener;
    };
  });

  async function loadStore(): Promise<typeof WorkflowsStore> {
    vi.resetModules();
    const module = await import('../workflows-store');
    module.useWorkflowsStore.getState().connect();
    return module;
  }

  it('takes a push for the project on show', async () => {
    const { useWorkflowsStore } = await loadStore();
    await useWorkflowsStore.getState().setProject('/a');

    pushEntries({ projectPath: '/a', entries: [entry('new')] });

    expect(useWorkflowsStore.getState().entries).toEqual([entry('new')]);
  });

  it('ignores a push for another project', async () => {
    const { useWorkflowsStore } = await loadStore();
    await useWorkflowsStore.getState().setProject('/a');

    pushEntries({ projectPath: '/b', entries: [entry('other')] });

    expect(useWorkflowsStore.getState().entries).toEqual([]);
  });

  it('drops a slow reply for a project that a person left', async () => {
    const { useWorkflowsStore } = await loadStore();
    const slow = deferred<WorkflowEntry[]>();
    list.mockReturnValueOnce(slow.promise).mockResolvedValueOnce([entry('b')]);

    const left = useWorkflowsStore.getState().setProject('/a');
    await useWorkflowsStore.getState().setProject('/b');
    slow.resolve([entry('a')]);
    await left;

    expect(useWorkflowsStore.getState().entries).toEqual([entry('b')]);
  });

  it('never shows the list of the last project under a new one', async () => {
    const { useWorkflowsStore } = await loadStore();
    list.mockResolvedValueOnce([entry('a')]);
    await useWorkflowsStore.getState().setProject('/a');
    const slow = deferred<WorkflowEntry[]>();
    list.mockReturnValueOnce(slow.promise);

    const switching = useWorkflowsStore.getState().setProject('/b');

    expect(useWorkflowsStore.getState().entries).toEqual([]);
    slow.resolve([]);
    await switching;
  });

  it('stays on a project that has no open pane when the panes change', async () => {
    const { useWorkflowsStore } = await loadStore();
    await useWorkflowsStore.getState().setProject('/added');

    await useWorkflowsStore.getState().loadProjects(['/open']);

    const { projectPath, projects } = useWorkflowsStore.getState();
    expect(projectPath).toBe('/added');
    expect(projects.map((project) => project.path)).toEqual(['/open', '/added']);
  });

  it('shows what went wrong, with no Electron text', async () => {
    const { showWorkflowError } = await loadStore();

    showWorkflowError(
      new Error("Error invoking remote method 'workflows:call': Error: This rule was deleted.")
    );

    expect(shown).toHaveBeenCalledWith('This rule was deleted.');
  });
});
