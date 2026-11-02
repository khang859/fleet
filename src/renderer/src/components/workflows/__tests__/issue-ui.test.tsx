// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowDef, WorkflowRun } from '../../../../../shared/workflows';
import { callWorkflows } from '../../../store/workflows-store';
import { ReportSection, RunHeader } from '../RunDetail';
import { TargetLine } from '../RunSheet';
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
    render(<RunHeader run={runOf()} onBack={vi.fn()} onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Run again' }));

    expect(callWorkflows).toHaveBeenCalledWith(
      'start',
      expect.objectContaining({ trustPr: false })
    );
  });
});
