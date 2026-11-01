import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { StartRunRequest } from '../../../shared/workflows';
import { ApprovalStore } from '../approval';
import { WorkflowCatalog } from '../catalog';
import { PROJECT_WORKFLOWS_DIR } from '../config';
import type { Exec, PrWire } from '../pr';
import { WorkflowStarts, type StartDeps } from '../starts';
import { flush, makeHarness, type Harness } from './helpers';

const TASK = `name = "Task"

[[inputs]]
name = "task"
label = "Task"

[[agents]]
role = "Worker"
program = "pi"
prompt = "{{task}}"
`;

const REVIEW = `name = "Review"
workspace = "pr-worktree"

[[inputs]]
name = "pr"
label = "Pull request"
type = "pr"

[[agents]]
role = "Reader"
program = "pi"
prompt = "Read it."
`;

const OPTIONAL_PR = `name = "Look"

[[inputs]]
name = "pr"
label = "Pull request"
type = "pr"
required = false

[[agents]]
role = "Worker"
program = "pi"
prompt = "Look."
`;

const TALKING = `name = "Talk"

[[stages]]
name = "Talk"

[[stages.agents]]
role = "Talker"
program = "pi"
talks = true
prompt = "Talk."
`;

const PLANNING = `name = "Plan"

[[stages]]
name = "Plan"

[[stages.agents]]
role = "Lead"
program = "claude"
access = "write"
plan = true
prompt = "Plan."
`;

const BRANCHING = `name = "Branch"
workspace = "new-branch"

[[stages]]
name = "Build"

[[stages.agents]]
role = "Lead"
program = "pi"
access = "write"
prompt = "Build."

[finish]
action = "open-pr"
`;

const OPTIONS = { origin: 'manual' as const, ruleId: null, focus: true };

function wirePr(fields: Partial<PrWire> = {}): PrWire {
  return {
    number: 12,
    title: 'Fix it',
    html_url: 'https://github.com/acme/app/pull/12',
    state: 'open',
    merged_at: null,
    author_association: 'MEMBER',
    user: { login: 'someone', type: 'User' },
    head: { sha: 'abc', repo: { full_name: 'acme/app' } },
    base: { repo: { full_name: 'acme/app' } },
    ...fields
  };
}

/** Plays `gh`: the repo slug and one pull request. */
function fakeGh(pr: PrWire, slug = 'acme/app'): Exec {
  return async (_command, args) =>
    Promise.resolve(args[0] === 'repo' ? `${slug}\n` : JSON.stringify(pr));
}

describe('WorkflowStarts', () => {
  let dir: string;
  let project: string;
  let catalog: WorkflowCatalog;
  let h: Harness;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fleet-wf-starts-'));
    project = join(dir, 'project');
    mkdirSync(project);
    const approvals = new ApprovalStore(join(dir, 'approvals.json'), randomBytes(32));
    catalog = new WorkflowCatalog(approvals, join(dir, 'personal'));
    h = makeHarness(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function makeStarts(fields: Partial<StartDeps> = {}): WorkflowStarts {
    return new WorkflowStarts({
      catalog,
      approvals: new ApprovalStore(join(dir, 'unused.json'), randomBytes(32)),
      runs: h.manager,
      exec: fakeGh(wirePr()),
      platform: 'darwin',
      bridgeProblem: () => null,
      hasProgram: async () => Promise.resolve(true),
      ...fields
    });
  }

  function saveApproved(id: string, text: string): void {
    const request = { projectPath: project, scope: 'project' as const, baseHash: null };
    catalog.save({ ...request, fileName: id, text });
  }

  function request(workflowId: string, inputs: Record<string, string>): StartRunRequest {
    return { projectPath: project, workflowId, inputs };
  }

  describe('refusals', () => {
    it('refuses a file nobody approved', async () => {
      mkdirSync(join(project, PROJECT_WORKFLOWS_DIR), { recursive: true });
      writeFileSync(join(project, PROJECT_WORKFLOWS_DIR, 'task.toml'), TASK);

      const result = await makeStarts().start(request('task', { task: 'x' }), OPTIONS);

      expect(result).toMatchObject({ ok: false, code: 'needs-approval' });
    });

    it('refuses a file that changed', async () => {
      saveApproved('task', TASK);
      const path = join(project, PROJECT_WORKFLOWS_DIR, 'task.toml');
      writeFileSync(path, `${TASK}\n`);

      const result = await makeStarts().start(request('task', { task: 'x' }), OPTIONS);

      expect(result).toMatchObject({ ok: false, code: 'changed' });
    });

    it('refuses an unknown workflow', async () => {
      const result = await makeStarts().start(request('nope', {}), OPTIONS);

      expect(result).toMatchObject({ ok: false, code: 'not-found' });
    });

    it('refuses a file that does not parse', async () => {
      mkdirSync(join(project, PROJECT_WORKFLOWS_DIR), { recursive: true });
      writeFileSync(join(project, PROJECT_WORKFLOWS_DIR, 'bad.toml'), 'name = ');

      const result = await makeStarts().start(request('bad', {}), OPTIONS);

      expect(result).toMatchObject({ ok: false, code: 'invalid' });
    });

    it('refuses a missing input', async () => {
      saveApproved('task', TASK);

      const result = await makeStarts().start(request('task', { task: '   ' }), OPTIONS);

      expect(result).toMatchObject({ ok: false, code: 'missing-input', message: 'Task is empty.' });
    });

    it('refuses a second run for one target', async () => {
      saveApproved('task', TASK);
      const starts = makeStarts();
      const first = await starts.start(request('task', { task: 'x' }), OPTIONS);

      const second = await starts.start(request('task', { task: 'x' }), OPTIONS);

      expect(first.ok).toBe(true);
      expect(second).toMatchObject({
        ok: false,
        code: 'duplicate',
        runId: first.ok ? first.runId : ''
      });
    });

    it('allows another target and a forced repeat', async () => {
      saveApproved('task', TASK);
      const starts = makeStarts();
      await starts.start(request('task', { task: 'x' }), OPTIONS);

      const other = await starts.start(request('task', { task: 'y' }), OPTIONS);
      const forced = await starts.start(
        { ...request('task', { task: 'x' }), force: true },
        OPTIONS
      );

      expect(other.ok).toBe(true);
      expect(forced.ok).toBe(true);
    });

    it('treats a number and a link as one target', async () => {
      saveApproved('review', REVIEW);
      const starts = makeStarts();
      await starts.start(request('review', { pr: '12' }), OPTIONS);

      const link = 'https://github.com/acme/app/pull/12';
      const second = await starts.start(request('review', { pr: link }), OPTIONS);

      expect(second).toMatchObject({ ok: false, code: 'duplicate' });
    });

    it('refuses a link to another repo', async () => {
      saveApproved('review', REVIEW);
      const link = 'https://github.com/other/thing/pull/12';

      const result = await makeStarts().start(request('review', { pr: link }), OPTIONS);

      expect(result).toMatchObject({ ok: false, code: 'other-repo' });
    });

    it('reads repo names with no regard for case', async () => {
      saveApproved('review', REVIEW);
      const link = 'https://github.com/ACME/App/pull/12';

      const result = await makeStarts().start(request('review', { pr: link }), OPTIONS);

      expect(result.ok).toBe(true);
    });

    it('refuses cleanly when gh cannot name the repo', async () => {
      saveApproved('review', REVIEW);
      const exec: Exec = async () => Promise.reject(new Error('gh is not signed in'));
      const link = 'https://github.com/acme/app/pull/12';

      const result = await makeStarts({ exec }).start(request('review', { pr: link }), OPTIONS);

      expect(result).toMatchObject({ ok: false, code: 'no-pr' });
    });

    it('refuses a closed PR unless asked', async () => {
      saveApproved('review', REVIEW);
      const starts = makeStarts({ exec: fakeGh(wirePr({ state: 'closed' })) });

      const closed = await starts.start(request('review', { pr: '12' }), OPTIONS);
      const anyway = await starts.start(
        { ...request('review', { pr: '12' }), allowClosedPr: true },
        OPTIONS
      );

      expect(closed).toMatchObject({ ok: false, code: 'pr-closed' });
      expect(anyway.ok).toBe(true);
    });

    it('refuses text that is no PR', async () => {
      saveApproved('review', REVIEW);

      const result = await makeStarts().start(request('review', { pr: 'junk' }), OPTIONS);

      expect(result).toMatchObject({ ok: false, code: 'bad-pr' });
    });

    it('refuses a PR that gh cannot find', async () => {
      saveApproved('review', REVIEW);
      const exec: Exec = async () => Promise.reject(new Error('Not Found'));

      const result = await makeStarts({ exec }).start(request('review', { pr: '12' }), OPTIONS);

      expect(result).toMatchObject({ ok: false, code: 'no-pr' });
    });

    it('refuses a project folder that is gone', async () => {
      const save = { projectPath: project, scope: 'personal' as const, baseHash: null };
      catalog.save({ ...save, fileName: 'task', text: TASK });
      rmSync(project, { recursive: true, force: true });

      const result = await makeStarts().start(request('task', { task: 'x' }), OPTIONS);

      expect(result).toMatchObject({ ok: false, code: 'no-project' });
    });

    it('refuses a program that is not installed', async () => {
      saveApproved('task', TASK);
      const starts = makeStarts({ hasProgram: async () => Promise.resolve(false) });

      const result = await starts.start(request('task', { task: 'x' }), OPTIONS);

      expect(result).toMatchObject({
        ok: false,
        code: 'check-failed',
        message: 'Pi is installed'
      });
    });

    it('refuses when the bridge is down', async () => {
      saveApproved('task', TASK);
      const starts = makeStarts({ bridgeProblem: () => 'Tracking is off.' });

      const result = await starts.start(request('task', { task: 'x' }), OPTIONS);

      expect(result).toMatchObject({
        ok: false,
        code: 'check-failed',
        message: 'Tracking is off.'
      });
    });

    it('refuses Claude Code on Windows', async () => {
      saveApproved('task', TASK.replace('"pi"', '"claude"'));
      const starts = makeStarts({ platform: 'win32' });

      const result = await starts.start(request('task', { task: 'x' }), OPTIONS);

      expect(result).toMatchObject({ ok: false, code: 'check-failed' });
    });
  });

  describe('runs', () => {
    it('starts an approved file', async () => {
      saveApproved('task', TASK);

      const result = await makeStarts().start(request('task', { task: 'Do This' }), OPTIONS);
      await flush();

      const run = h.manager.list()[0];

      expect(result).toEqual({ ok: true, runId: run.id });
      expect(run.state).toBe('running');
      expect(run.slug).toBe('do-this');
      expect(run.target).toBe('["Do This"]');
      expect(run.locked).toBe(false);
    });

    it('starts with a blank optional PR', async () => {
      saveApproved('look', OPTIONAL_PR);

      const result = await makeStarts().start(request('look', { pr: ' ' }), OPTIONS);

      expect(result.ok).toBe(true);
      expect(h.manager.list()[0].pr).toBeNull();
    });

    it('uses another program when asked', async () => {
      saveApproved('task', TASK);
      const req = { ...request('task', { task: 'x' }), programOverride: 'claude' as const };

      await makeStarts().start(req, OPTIONS);
      await flush();

      expect(h.opened[0].line).toMatch(/^exec claude /);
    });

    it('locks a stranger PR', async () => {
      saveApproved('review', REVIEW);
      const stranger = wirePr({ author_association: 'NONE' });

      await makeStarts({ exec: fakeGh(stranger) }).start(request('review', { pr: '12' }), OPTIONS);
      await flush();

      expect(h.manager.list()[0].locked).toBe(true);
      expect(h.opened[0].line).toContain('--no-approve');
    });

    it('locks a fork of a member', async () => {
      saveApproved('review', REVIEW);
      const fork = wirePr({ head: { sha: 'abc', repo: { full_name: 'someone/app' } } });

      await makeStarts({ exec: fakeGh(fork) }).start(request('review', { pr: '12' }), OPTIONS);

      expect(h.manager.list()[0].locked).toBe(true);
    });

    it('unlocks a stranger PR a person trusts', async () => {
      saveApproved('review', REVIEW);
      const stranger = wirePr({ author_association: 'NONE' });
      const req = { ...request('review', { pr: '12' }), trustPr: true };

      await makeStarts({ exec: fakeGh(stranger) }).start(req, OPTIONS);
      await flush();

      expect(h.manager.list()[0].locked).toBe(false);
      expect(h.opened[0].line).toContain(`'--approve'`);
    });

    it('does not skip the trust question outside a new worktree', async () => {
      saveApproved('review', REVIEW.replace('workspace = "pr-worktree"\n', ''));

      await makeStarts().start(request('review', { pr: '12' }), OPTIONS);
      await flush();

      expect(h.opened[0].line).not.toContain(`'--approve'`);
    });
  });

  describe('stage files', () => {
    const automatic = { ...OPTIONS, origin: 'automatic' as const };

    it('refuses an automatic start of a file that talks', async () => {
      saveApproved('talk', TALKING);

      const result = await makeStarts().start(request('talk', {}), automatic);

      expect(result).toMatchObject({ ok: false, code: 'needs-person' });
    });

    it('refuses an automatic start of a file with a plan', async () => {
      saveApproved('plan', PLANNING);

      const result = await makeStarts().start(request('plan', {}), automatic);

      expect(result).toMatchObject({ ok: false, code: 'needs-person' });
    });

    it('starts a talking file for a person', async () => {
      saveApproved('talk', TALKING);

      const result = await makeStarts().start(request('talk', {}), OPTIONS);

      expect(result).toMatchObject({ ok: true });
    });

    it('checks the program of each stage', async () => {
      saveApproved('plan', PLANNING);
      const hasProgram = async (program: string): Promise<boolean> =>
        Promise.resolve(program !== 'claude');

      const result = await makeStarts({ hasProgram }).start(request('plan', {}), OPTIONS);

      expect(result).toMatchObject({ ok: false });
    });

    it('needs gh for an open-pr file', async () => {
      saveApproved('branch', BRANCHING);
      const exec: Exec = async () => Promise.reject(new Error('no gh'));

      const result = await makeStarts({ exec }).start(request('branch', {}), OPTIONS);

      expect(result).toMatchObject({ ok: false });
    });
  });

  describe('preview', () => {
    it('reports a bad file', async () => {
      const preview = await makeStarts().preview(request('nope', {}));

      expect(preview.checks).toEqual([{ label: 'The workflow file is valid', ok: false }]);
    });

    it('shows the PR and whether it is locked', async () => {
      saveApproved('review', REVIEW);
      const stranger = wirePr({ author_association: 'NONE' });

      const preview = await makeStarts({ exec: fakeGh(stranger) }).preview(
        request('review', { pr: '12' })
      );

      expect(preview.pr).toMatchObject({ number: 12, state: 'open', locked: true });
      expect(preview.checks.every((check) => check.ok)).toBe(true);
    });

    it('finds an active run for the target', async () => {
      saveApproved('task', TASK);
      const starts = makeStarts();
      const req = request('task', { task: 'x' });
      const started = await starts.start(req, OPTIONS);

      const preview = await starts.preview(req);

      expect(preview.duplicateRunId).toBe(started.ok ? started.runId : '');
    });

    it('fails a check for another repo', async () => {
      saveApproved('review', REVIEW);
      const link = 'https://github.com/other/thing/pull/12';

      const preview = await makeStarts().preview(request('review', { pr: link }));

      expect(preview.pr).toBeNull();
      expect(preview.checks.some((check) => !check.ok)).toBe(true);
    });
  });
});
