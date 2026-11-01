import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RunReport, WorkflowRun } from '../../../shared/workflows';
import { reportMarker, type Exec } from '../pr';
import { WorkflowPosting } from '../posting';
import {
  makeDef,
  makeHarness,
  makePlan,
  SAMPLE_PR,
  sessionsUp,
  startRun,
  type Harness
} from './helpers';

function makeReport(overrides: Partial<RunReport> = {}): RunReport {
  return {
    text: '# Review\n\nNo problems left.',
    incomplete: false,
    missing: [],
    savedTo: null,
    posted: false,
    ...overrides
  };
}

describe('WorkflowPosting', () => {
  let dir: string;
  let h: Harness;
  let run: WorkflowRun;
  let comments: Array<{ number: string; body: string | undefined }>;
  let existing: string;
  let failing: boolean;
  let listFails: boolean;
  let posting: WorkflowPosting;

  /** Plays `gh`: it records each comment and lists what is on the PR. */
  const exec: Exec = async (_command, args, _cwd, input) => {
    if (args[0] === 'api') {
      return listFails ? Promise.reject(new Error('no answer')) : Promise.resolve(existing);
    }
    if (failing) return Promise.reject(new Error('gh failed'));
    comments.push({ number: args[2], body: input });
    return Promise.resolve('');
  };

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'fleet-wf-posting-'));
    comments = [];
    existing = '';
    failing = false;
    listFails = false;
    h = makeHarness(dir);
    const def = makeDef({ workspace: 'pr-worktree' });
    run = await startRun(h, makePlan(def, { pr: SAMPLE_PR }));
    sessionsUp(h, run);
    run.report = makeReport();
    posting = new WorkflowPosting({ runs: h.manager, exec });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('posts the report as one comment with a hidden mark', async () => {
    await posting.post(run.id);

    expect(comments).toHaveLength(1);
    expect(comments[0].number).toBe('7');
    expect(comments[0].body).toContain('No problems left.');
    expect(comments[0].body).toContain(reportMarker(run.id));
    expect(run.report?.posted).toBe(true);
  });

  it('never posts a board item that the report dropped', async () => {
    h.manager.addFinding(run.id, run.agents[0].id, { kind: 'Nit', text: 'dropped by the lead' });

    await posting.post(run.id);

    expect(comments).toHaveLength(1);
    expect(comments[0].body).not.toContain('dropped by the lead');
  });

  it('never posts twice', async () => {
    await posting.post(run.id);
    await posting.post(run.id);

    expect(comments).toHaveLength(1);
  });

  it('never posts twice at once', async () => {
    await Promise.allSettled([posting.post(run.id), posting.post(run.id)]);

    expect(comments).toHaveLength(1);
  });

  it('marks a report that a lost answer hid, and posts nothing', async () => {
    existing = `Looks good.\n${reportMarker(run.id)}\n`;

    await posting.post(run.id);

    expect(comments).toHaveLength(0);
    expect(run.report?.posted).toBe(true);
  });

  it('stays not posted when the post fails, and works on the next try', async () => {
    failing = true;
    await expect(posting.post(run.id)).rejects.toThrow('gh failed');
    expect(run.report?.posted).toBe(false);

    failing = false;
    await posting.post(run.id);

    expect(comments).toHaveLength(1);
    expect(run.report?.posted).toBe(true);
  });

  it('posts nothing when the PR cannot say what it holds', async () => {
    listFails = true;

    await expect(posting.post(run.id)).rejects.toThrow('no answer');

    expect(comments).toHaveLength(0);
    expect(run.report?.posted).toBe(false);
  });

  it('keeps the posted mark on disk', async () => {
    await posting.post(run.id);

    const saved = h.deps.store.loadAll().find((other) => other.id === run.id);

    expect(saved?.report?.posted).toBe(true);
  });

  it('refuses a run with no PR', async () => {
    const plain = await startRun(h, makePlan(makeDef(), { target: 'other' }));
    plain.report = makeReport();

    await expect(posting.post(plain.id)).rejects.toThrow('no pull request');
  });

  it('refuses a run with no report', async () => {
    run.report = null;

    await expect(posting.post(run.id)).rejects.toThrow('no report');
  });

  it('refuses an incomplete report', async () => {
    run.report = makeReport({ incomplete: true });

    await expect(posting.post(run.id)).rejects.toThrow('incomplete');
    expect(comments).toHaveLength(0);
  });

  it('refuses a run that is gone', async () => {
    await expect(posting.post('gone')).rejects.toThrow('gone');
  });
});
