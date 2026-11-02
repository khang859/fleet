// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  StartRunRequest,
  WorkflowDef,
  WorkflowEntry,
  WorkflowPreview,
  WorkflowRun
} from '../../../../../shared/workflows';
import { callWorkflows } from '../../../store/workflows-store';
import { ReportSection, RunHeader } from '../RunDetail';
import { RunSheet, TargetLine } from '../RunSheet';
import { EndPanel } from '../StageEditor';
import { finishNote } from '../stage-notes';

vi.mock('../../../store/workflows-store', async (original) => {
  Object.assign(window, { fleet: { homeDir: '/home', workflows: { call: vi.fn(), on: vi.fn() } } });
  return {
    ...(await original<object>()),
    callWorkflows: vi.fn()
  };
});

const DEF: WorkflowDef = {
  name: 'Issues',
  shared: '',
  board: false,
  workspace: 'current',
  inputs: [],
  agents: [],
  judge: { role: 'Judge', program: 'pi', prompt: 'Join.' }
};

const ISSUE = { number: 9, title: 'It breaks', url: 'https://x/9', state: 'open' };

function runOf(fields: object = {}): WorkflowRun {
  return {
    id: 'run-1',
    projectPath: '/repo',
    workflowId: 'issue',
    workflowName: 'Issues',
    inputs: { issue: '9' },
    state: 'finished',
    agents: [],
    keptPanes: [],
    pr: null,
    issue: ISSUE,
    locked: false,
    finish: { action: 'post-issue' },
    report: { text: 'Done.', incomplete: false, missing: [], savedTo: null, posted: false },
    ...fields
  } as unknown as WorkflowRun;
}

const BOTH_INPUTS = [
  { name: 'pr', label: 'Pull request', type: 'pr', required: true },
  { name: 'issue', label: 'Issue', type: 'issue', required: true }
] as const;

const BOTH_ENTRY = {
  id: 'both',
  approval: 'approved',
  def: { ...DEF, inputs: [...BOTH_INPUTS] }
} as unknown as WorkflowEntry;

const PR = { number: 12, title: 'Fix it', url: 'https://x/12', state: 'open' as const };

/** Plays the main process: each target is locked until the request trusts it. */
function previewOf(request: StartRunRequest): WorkflowPreview {
  return {
    checks: [],
    pr: { ...PR, locked: request.trustPr !== true },
    issue: { ...ISSUE, state: 'open', locked: request.trustIssue !== true },
    programNotes: [],
    duplicateRunId: null
  };
}

function mockPreviews(): void {
  vi.mocked(callWorkflows).mockImplementation(async (name: string, ...args: unknown[]) =>
    Promise.resolve(name === 'preview' ? previewOf(args[0] as StartRunRequest) : null)
  );
}

function lastPreview(): StartRunRequest {
  const calls = vi.mocked(callWorkflows).mock.calls.filter(([name]) => name === 'preview');
  return calls[calls.length - 1][1] as StartRunRequest;
}

/** The button goes once the preview that holds the trust is back. */
async function trust(name: string): Promise<void> {
  fireEvent.click(screen.getByRole('button', { name }));
  await waitFor(() => expect(screen.queryByRole('button', { name })).toBeNull());
}

async function renderBothLocked(): Promise<void> {
  mockPreviews();
  render(
    <RunSheet
      projectPath="/repo"
      entry={BOTH_ENTRY}
      initialInputs={{ pr: '12', issue: '9' }}
      onClose={vi.fn()}
    />
  );
  await screen.findByRole('button', { name: 'Trust this PR' });
}

describe('issue parts of the workflow UI', () => {
  beforeEach(() => {
    vi.mocked(callWorkflows).mockResolvedValue({ ok: true, runId: 'run-2' });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('names the finish of the stage map', () => {
    expect(finishNote({ ...DEF, finish: { action: 'post-issue' } })).toBe('Posts on the issue');
  });

  it('lets a person pick post-issue', () => {
    const onChange = vi.fn();
    render(<EndPanel def={DEF} onChange={onChange} />);

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'post-issue' } });

    expect(onChange).toHaveBeenCalledWith({ ...DEF, finish: { action: 'post-issue' } });
  });

  it('shows a closed, locked issue with a way to trust it', () => {
    const onTrust = vi.fn();
    render(
      <TargetLine
        target={{ ...ISSUE, locked: true }}
        noun="issue"
        from="People outside the team wrote some of this issue."
        closed
        trusted={false}
        onTrust={onTrust}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Trust this issue' }));

    expect(screen.getByText('Closed')).toBeTruthy();
    expect(screen.getByText('Locked')).toBeTruthy();
    expect(onTrust).toHaveBeenCalledOnce();
  });

  it('shows neither badge on an open team issue', () => {
    render(
      <TargetLine
        target={{ ...ISSUE, locked: false }}
        noun="issue"
        from="Outside."
        trusted={false}
        onTrust={vi.fn()}
      />
    );

    expect(screen.queryByText('Closed')).toBeNull();
    expect(screen.queryByText('Locked')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Trust this issue' })).toBeNull();
  });

  it('makes Post the main button with post-issue', () => {
    render(<ReportSection run={runOf()} onSave={vi.fn()} onPost={vi.fn()} />);

    const post = screen.getByRole('button', { name: 'Post' });
    const save = screen.getByRole('button', { name: 'Save report' });
    expect(post.className).toContain('--fleet-accent');
    expect(save.className).not.toContain('--fleet-accent');
  });

  it('removes Post once the report is posted', () => {
    const report = { text: 'Done.', incomplete: false, missing: [], savedTo: null, posted: true };
    render(<ReportSection run={runOf({ report })} onSave={vi.fn()} onPost={vi.fn()} />);

    expect(screen.queryByRole('button', { name: 'Post' })).toBeNull();
    expect(screen.getByText('Posted to issue #9')).toBeTruthy();
  });

  it('does not trust an issue on a rerun', () => {
    render(<RunHeader run={runOf({ pr: PR })} onBack={vi.fn()} onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Run again' }));

    expect(callWorkflows).toHaveBeenCalledWith('start', expect.objectContaining({ trustPr: true }));
    expect(vi.mocked(callWorkflows).mock.calls[0][1]).not.toHaveProperty('trustIssue');
  });

  it('keeps a locked PR locked on a rerun', () => {
    const run = runOf({ pr: PR, locked: true });
    render(<RunHeader run={run} onBack={vi.fn()} onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Run again' }));

    expect(callWorkflows).toHaveBeenCalledWith(
      'start',
      expect.objectContaining({ trustPr: false })
    );
  });

  it('trusts only the target a person picks', async () => {
    await renderBothLocked();

    await trust('Trust this PR');

    expect(screen.getAllByText('Trusted')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Trust this issue' })).toBeTruthy();
    expect(lastPreview()).toMatchObject({ trustPr: true, trustIssue: false });
  });

  it('asks again when the trusted issue changes', async () => {
    await renderBothLocked();
    await trust('Trust this issue');
    await trust('Trust this PR');

    fireEvent.change(screen.getByLabelText('Issue'), { target: { value: '10' } });

    await screen.findByRole('button', { name: 'Trust this issue' });
    expect(lastPreview()).toMatchObject({ trustPr: true, trustIssue: false });
  });

  it('asks again when the trusted PR changes', async () => {
    await renderBothLocked();
    await trust('Trust this PR');

    fireEvent.change(screen.getByLabelText('Pull request'), { target: { value: '13' } });

    await screen.findByRole('button', { name: 'Trust this PR' });
    expect(lastPreview()).toMatchObject({ trustPr: false });
  });
});
