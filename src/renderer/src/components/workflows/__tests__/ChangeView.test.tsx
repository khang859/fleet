// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowDef, WorkflowEntry } from '../../../../../shared/workflows';
import { callWorkflows } from '../../../store/workflows-store';
import { ChangeView } from '../ChangeView';
import { formToToml } from '../workflow-toml';

vi.mock('../../../store/workflows-store', () => ({
  callWorkflows: vi.fn(),
  showWorkflowError: vi.fn()
}));

const DEF: WorkflowDef = {
  name: 'Small',
  shared: 'Be careful.',
  board: true,
  workspace: 'current',
  inputs: [],
  agents: [{ role: 'Reader', program: 'pi', prompt: 'Read the code.' }],
  judge: { role: 'Judge', program: 'claude', prompt: 'Merge the findings.' }
};

function entryOf(overrides: Partial<WorkflowEntry> = {}): WorkflowEntry {
  return {
    id: 'small',
    path: '/tmp/small.toml',
    scope: 'project',
    hash: 'hash-1',
    def: DEF,
    error: null,
    approval: 'needs-approval',
    replacesPersonal: false,
    approvedText: null,
    ...overrides
  };
}

function showFile(entry: WorkflowEntry): ReturnType<typeof vi.fn> {
  const onRead = vi.fn();
  render(<ChangeView entry={entry} onRead={onRead} />);
  return onRead;
}

describe('ChangeView', () => {
  beforeEach(() => {
    vi.mocked(callWorkflows).mockResolvedValue(formToToml(DEF));
  });

  afterEach(cleanup);

  it('shows every prompt of a new file, and says when the file was read', async () => {
    const onRead = showFile(entryOf());

    expect(await screen.findByText('Be careful.')).toBeTruthy();
    expect(screen.getByText('Read the code.')).toBeTruthy();
    expect(screen.getByText('Merge the findings.')).toBeTruthy();
    expect(screen.getByText('Goes last')).toBeTruthy();
    expect(onRead).toHaveBeenCalledWith('hash-1');
  });

  it('switches to the raw file and back', async () => {
    showFile(entryOf());
    await screen.findByText('Read the code.');

    fireEvent.click(screen.getByRole('button', { name: 'Raw file' }));

    expect(screen.getByText('[[agents]]')).toBeTruthy();
    expect(screen.queryByText('Goes last')).toBeNull();
    expect(screen.getByRole('button', { name: 'Raw file' }).getAttribute('aria-pressed')).toBe(
      'true'
    );

    fireEvent.click(screen.getByRole('button', { name: 'Readable' }));

    expect(screen.getByText('Goes last')).toBeTruthy();
    expect(screen.queryByText('[[agents]]')).toBeNull();
  });

  it('marks what changed since the approved version', async () => {
    const approved = { ...DEF, agents: [{ ...DEF.agents[0], prompt: 'Read the docs.' }] };
    showFile(entryOf({ approval: 'changed', approvedText: formToToml(approved) }));

    expect(await screen.findByText(/1 agent changed\./)).toBeTruthy();
    expect(screen.getByText('Changed')).toBeTruthy();
    expect(screen.getByText('Read the docs.')).toBeTruthy();
    expect(screen.getByText('Read the code.')).toBeTruthy();
  });

  it('shows only the raw file when the file has no parsed workflow', async () => {
    showFile(entryOf({ def: null }));

    expect(await screen.findByText('[[agents]]')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Raw file' })).toBeNull();
  });
});
