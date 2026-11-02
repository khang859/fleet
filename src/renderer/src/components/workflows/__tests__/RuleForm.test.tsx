// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowDef, WorkflowEntry, WorkflowRule } from '../../../../../shared/workflows';
import { callWorkflows } from '../../../store/workflows-store';
import { RuleForm } from '../RuleForm';

const store = vi.hoisted(() => ({ entries: [] as WorkflowEntry[] }));

vi.mock('../../../store/workflows-store', () => ({
  callWorkflows: vi.fn(),
  showWorkflowError: vi.fn(),
  useWorkflowsStore: (pick: (state: typeof store) => unknown) => pick(store)
}));

const DEF: WorkflowDef = {
  name: 'Task',
  shared: '',
  board: true,
  workspace: 'current',
  inputs: [],
  agents: [{ role: 'Doer', program: 'pi', prompt: 'Do it.' }],
  judge: { role: 'Judge', program: 'claude', prompt: 'Merge.' }
};

function entryOf(overrides: Partial<WorkflowEntry>): WorkflowEntry {
  return {
    id: 'task',
    path: '/repo/.fleet/workflows/task.toml',
    scope: 'project',
    hash: 'hash-1',
    def: DEF,
    error: null,
    approval: 'approved',
    disabled: false,
    approvedText: null,
    ...overrides
  };
}

const RULE: WorkflowRule = {
  id: 'rule-1',
  name: 'Daily',
  projectPath: '/repo',
  workflowId: 'task',
  workflowScope: 'personal',
  inputs: {},
  trigger: { kind: 'time', at: '09:00', days: [1] },
  missed: 'skip',
  enabled: true,
  pausedReason: 'Its workflow is turned off.',
  dailyLimit: 5,
  lastStart: null,
  createdAt: 0
};

afterEach(cleanup);

describe('RuleForm', () => {
  it('keeps the rule on its own file when that file is turned off', () => {
    store.entries = [
      entryOf({}),
      entryOf({ path: '/home/me/workflows/task.toml', scope: 'personal', disabled: true })
    ];
    render(<RuleForm projectPath="/repo" rule={RULE} onClose={() => undefined} />);

    const select = screen.getByRole<HTMLSelectElement>('combobox', { name: 'Workflow' });
    expect(select.value).toBe('/home/me/workflows/task.toml');
    expect(select.selectedOptions[0].textContent).toBe('Task (Personal) - turned off');

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(callWorkflows).toHaveBeenCalledWith(
      'saveRule',
      expect.objectContaining({ workflowId: 'task', workflowScope: 'personal' })
    );
  });
});
