import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WorkflowNotice, WorkflowRun } from '../../../shared/workflows';
import { parseWorkflow } from '../config';
import {
  ADD_TIME_MS,
  buildReport,
  DEFAULT_LIMIT_MS,
  LIMIT_GRACE_MS,
  noticeIsCurrent,
  SILENCE_MS,
  START_DEADLINE_MS
} from '../run-manager';
import { STARTERS } from '../starters';
import {
  agentDef,
  flush,
  makeDef,
  makeHarness,
  makePlan,
  makeRun,
  paneOf,
  SAMPLE_ISSUE,
  SAMPLE_PR,
  sessionsUp,
  START_TIME,
  startRun,
  type Harness
} from './helpers';

const WITH_JUDGE = makeDef({ judge: agentDef('Judge') });
const ONE_AGENT = makeDef({ agents: [agentDef('Solo')] });

describe('WorkflowRunManager', () => {
  let dir: string;
  let h: Harness;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fleet-wf-runs-'));
    h = makeHarness(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** The agent is up and working. */
  async function workingRun(def = makeDef(), plan = {}): Promise<WorkflowRun> {
    const run = await startRun(h, makePlan(def, plan));
    sessionsUp(h, run);
    return run;
  }

  /** Holds each new pane open until the test says so. */
  function deferredOpen(): { resolve: () => void } {
    let resolve: () => void = () => undefined;
    const gate = new Promise<void>((done) => {
      resolve = done;
    });
    h.deps.openPane = async () => gate;
    return { resolve: () => resolve() };
  }

  function finishAll(run: WorkflowRun): void {
    for (const agent of run.agents) {
      if (agent.paneId !== null) h.manager.finishAgent(run.id, agent.id, `${agent.role} is done.`);
    }
  }

  describe('start', () => {
    it('opens a pane per agent and reaches running', async () => {
      const run = await startRun(h, makePlan(WITH_JUDGE));

      expect(run.state).toBe('running');
      expect(h.opened).toHaveLength(2);
      expect(h.opened[0].cwd).toBe('/repo');
      expect(h.opened[0].line).toMatch(/^exec pi /);
      expect(run.agents.map((agent) => agent.state)).toEqual(['starting', 'starting', 'pending']);
      expect(run.agents.map((agent) => agent.isLast)).toEqual([false, false, true]);
    });

    it('moves an agent to working when its session starts', async () => {
      const run = await workingRun();

      expect(run.agents[0].state).toBe('working');
      expect(run.agents[0].sessionId).toBe('session-First');
    });

    it('writes each brief to a file', async () => {
      const run = await startRun(h, makePlan(ONE_AGENT));
      const path = join(h.deps.store.folder(run.id), 'prompts', `${run.agents[0].id}.md`);

      expect(existsSync(path)).toBe(true);
      expect(h.opened[0].line).toContain(path);
    });

    it('keeps the issue text in a new brief, for a retried agent', async () => {
      const plan = makePlan(ONE_AGENT, { issue: SAMPLE_ISSUE, issueText: 'The real text.' });
      const run = await startRun(h, plan);
      const path = join(h.deps.store.folder(run.id), 'prompts', `${run.agents[0].id}.md`);
      sessionsUp(h, run);
      rmSync(path);

      await h.manager.retry(run.id, run.agents[0].id);

      expect(readFileSync(path, 'utf8')).toContain('The real text.');
    });

    it('gives every agent of the issue starter read tools and no bash', async () => {
      const starter = STARTERS.find((candidate) => candidate.id === 'issue-review');
      const def = parseWorkflow(starter?.text ?? '');

      await startRun(h, makePlan(def, { issue: SAMPLE_ISSUE, issueText: 'Text.' }));

      expect(h.opened).toHaveLength(3);
      for (const { line } of h.opened) {
        expect(line).toContain('read,grep,find,ls,fleet_*');
        expect(line).not.toContain('bash');
      }
    });

    it('tells the bridge what each pane is', async () => {
      const run = await startRun(h, makePlan(WITH_JUDGE));

      expect(h.manager.identify(paneOf(run, 0))).toMatchObject({ kind: 'run', runId: run.id });
      expect(h.manager.identify('stranger')).toEqual({ kind: 'outside' });
    });

    it('fails the agent when its pane does not open', async () => {
      h = makeHarness(dir, {
        openPane: async () => Promise.reject(new Error('no shell'))
      });

      const run = await startRun(h, makePlan(ONE_AGENT));

      expect(run.agents[0].state).toBe('failed');
      expect(run.agents[0].note).toContain('no shell');
    });
  });

  describe('queue', () => {
    it('waits behind the agent limit and starts when there is room', async () => {
      h = makeHarness(dir, { maxAgents: () => 2 });
      const first = await workingRun();
      const second = await startRun(h, makePlan(ONE_AGENT, { target: 'other' }));

      expect(second.state).toBe('queued');
      expect(second.problem).toContain('2 agents');
      expect(h.notices.map((notice) => notice.kind)).toContain('queued');

      finishAll(first);
      await h.advance(1000);

      expect(second.state).toBe('running');
      expect(second.problem).toBeNull();
    });

    it('counts a run that is preparing, so two queued runs do not both start', async () => {
      h = makeHarness(dir, { maxAgents: () => 2 });
      const first = await workingRun();
      const second = await startRun(h, makePlan(makeDef(), { target: 'two' }));
      const third = await startRun(h, makePlan(makeDef(), { target: 'three' }));

      finishAll(first);
      await h.advance(1000);

      expect(second.state).toBe('running');
      expect(third.state).toBe('queued');
    });

    it('leaves a queued run in the queue when a person asks to try again', async () => {
      h = makeHarness(dir, { maxAgents: () => 2 });
      await workingRun();
      const second = await startRun(h, makePlan(ONE_AGENT, { target: 'other' }));

      h.manager.retryPrepare(second.id);
      await flush();

      expect(second.state).toBe('queued');
    });

    it('never counts a queued run as active time', async () => {
      h = makeHarness(dir, { maxAgents: () => 2 });
      await workingRun();
      const second = await startRun(h, makePlan(ONE_AGENT));

      await h.advance(60_000);

      expect(second.activeMs).toBe(0);
    });
  });

  describe('PR worktrees', () => {
    const prDef = makeDef({ workspace: 'pr-worktree' });

    it('runs in the worktree of a PR', async () => {
      const run = await startRun(h, makePlan(prDef, { pr: SAMPLE_PR }));

      expect(run.cwd).toBe('/worktrees/run');
      expect(run.pr?.headSha).toBe('new-sha');
      expect(h.opened[0].cwd).toBe('/worktrees/run');
    });

    it('stays in the project for a current workspace', async () => {
      const run = await startRun(h, makePlan(makeDef(), { pr: SAMPLE_PR }));

      expect(run.cwd).toBe('/repo');
      expect(run.worktreePath).toBeNull();
    });

    it('needs a person when the worktree fails, and stays there', async () => {
      h = makeHarness(dir, {
        makeWorktree: async () => Promise.reject(new Error('no network'))
      });

      const run = await startRun(h, makePlan(prDef, { pr: SAMPLE_PR }));

      expect(run.state).toBe('needs-you');
      expect(run.problem).toContain('no network');

      await h.advance(30_000);

      expect(run.state).toBe('needs-you');
      expect(h.opened).toHaveLength(0);
    });

    it('tries the worktree again', async () => {
      let calls = 0;
      h = makeHarness(dir, {
        makeWorktree: async () => {
          calls += 1;
          if (calls === 1) return Promise.reject(new Error('no network'));
          return Promise.resolve({ path: '/worktrees/run', sha: 'sha' });
        }
      });
      const run = await startRun(h, makePlan(prDef, { pr: SAMPLE_PR }));

      h.manager.retryPrepare(run.id);
      await flush();

      expect(run.state).toBe('running');
      expect(run.problem).toBeNull();
      expect(h.opened).toHaveLength(2);
    });

    it('goes on after a cut that came before the worktree', async () => {
      let calls = 0;
      h = makeHarness(dir, {
        makeWorktree: async () => {
          calls += 1;
          if (calls === 1) return Promise.reject(new Error('no network'));
          return Promise.resolve({ path: '/worktrees/run', sha: 'sha' });
        }
      });
      const run = await startRun(h, makePlan(prDef, { pr: SAMPLE_PR }));
      h.manager.markCutOff();
      const manager = h.relaunch();

      await manager.goOn(run.id);

      expect(manager.get(run.id)?.state).toBe('running');
      expect(manager.get(run.id)?.problem).toBeNull();
      expect(h.opened).toHaveLength(2);
    });

    it('removes a worktree that finished after its run closed', async () => {
      let finish: () => void = () => undefined;
      const removed: Array<string | null> = [];
      h = makeHarness(dir, {
        makeWorktree: async () =>
          new Promise((resolve) => {
            finish = () => resolve({ path: '/worktrees/run', sha: 'sha' });
          }),
        removeWorktree: async (run) => {
          removed.push(run.worktreePath);
          return Promise.resolve();
        }
      });
      const run = await startRun(h, makePlan(prDef, { pr: SAMPLE_PR }));

      h.manager.close(run.id, true);
      finish();
      await flush();

      expect(removed).toEqual(['/worktrees/run']);
      expect(run.worktreePath).toBeNull();
      expect(run.cwd).toBe(run.projectPath);
      expect(h.opened).toHaveLength(0);
    });

    it('does not revive a run stopped during the worktree', async () => {
      let release: () => void = () => undefined;
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      h = makeHarness(dir, {
        makeWorktree: async () => {
          await blocked;
          return { path: '/worktrees/run', sha: 'sha' };
        }
      });
      const run = await startRun(h, makePlan(prDef, { pr: SAMPLE_PR }));

      h.manager.stop(run.id);
      release();
      await flush();

      expect(run.state).toBe('stopped');
      expect(h.opened).toHaveLength(0);
    });
  });

  describe('stop during start', () => {
    let release: () => void;
    let events: string[];

    beforeEach(() => {
      events = [];
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      h = makeHarness(dir, {
        openPane: async () => {
          events.push('opening');
          await blocked;
          events.push('opened');
        },
        killPane: () => {
          events.push('killed');
        }
      });
    });

    it('holds room for agents it has yet to open', async () => {
      h = makeHarness(dir, {
        maxAgents: () => 2,
        openPane: async () => new Promise<void>(() => undefined)
      });
      await startRun(h, makePlan(makeDef(), { target: 'first' }));

      const second = await startRun(h, makePlan(ONE_AGENT, { target: 'second' }));

      expect(second.state).toBe('queued');
    });

    it('stops a resumed run from opening the next pane', async () => {
      let gate = Promise.resolve();
      const opened: string[] = [];
      h = makeHarness(dir, {
        openPane: async (pane) => {
          opened.push(pane.paneId);
          await gate;
        }
      });
      const run = await workingRun();
      h.manager.markCutOff();
      const manager = h.relaunch();
      opened.length = 0;
      gate = new Promise((resolve) => {
        release = resolve;
      });

      const going = manager.goOn(run.id);
      await flush();
      manager.stop(run.id);
      release();
      await going;

      expect(manager.get(run.id)?.state).toBe('stopped');
      expect(opened).toHaveLength(1);
    });

    it('does not open the next pane', async () => {
      const run = await startRun(h, makePlan(makeDef()));

      h.manager.stop(run.id);
      release();
      await flush();

      expect(run.state).toBe('stopped');
      expect(events.filter((event) => event === 'opening')).toHaveLength(1);
    });

    it('kills a pane that opened after the stop', async () => {
      const run = await startRun(h, makePlan(ONE_AGENT));

      h.manager.stop(run.id);
      release();
      await flush();

      expect(events).toEqual(['opening', 'killed', 'opened', 'killed']);
    });
  });

  describe('turn end', () => {
    it('reminds once, then asks a person', async () => {
      const run = await workingRun(ONE_AGENT);
      const pane = paneOf(run, 0);

      const reminder = h.manager.onTurnEnd(pane);

      expect(reminder).toContain('fleet_run_finish');
      expect(run.agents[0].state).toBe('working');
      expect(run.state).toBe('running');

      expect(h.manager.onTurnEnd(pane)).toBeNull();
      expect(run.agents[0].state).toBe('waiting');
      expect(run.agents[0].needsPerson).toBe(true);
      expect(run.state).toBe('needs-you');
      expect(h.notices.map((notice) => notice.kind)).toContain('needs-you');
    });

    it('does not remind after a turn a person started', async () => {
      const run = await workingRun(ONE_AGENT);
      const pane = paneOf(run, 0);

      h.manager.onPersonInput(pane, 'fix it\r');

      expect(h.manager.onTurnEnd(pane)).toBeNull();
      expect(run.agents[0].state).toBe('waiting');
      expect(run.agents[0].needsPerson).toBe(false);
      expect(run.agents[0].personTyped).toBe(true);
    });

    it('goes back to work on a new turn', async () => {
      const run = await workingRun(ONE_AGENT);
      const pane = paneOf(run, 0);
      h.manager.onTurnEnd(pane);
      h.manager.onTurnEnd(pane);

      h.manager.onTurnStart(pane);

      expect(run.agents[0].state).toBe('working');
      expect(run.state).toBe('running');
    });

    it('ignores a pane Fleet does not know', () => {
      expect(h.manager.onTurnEnd('stranger')).toBeNull();
    });

    it('asks a person for a permission', async () => {
      const run = await workingRun(ONE_AGENT);

      h.manager.onPermission(paneOf(run, 0), 'use-1', 'Bash');

      expect(run.agents[0].pendingPermission).toEqual({ toolUseId: 'use-1', tool: 'Bash' });
      expect(run.state).toBe('needs-you');
    });
  });

  describe('finish', () => {
    it('marks an agent done and the run finished', async () => {
      const run = await workingRun(ONE_AGENT);

      expect(h.manager.finishAgent(run.id, run.agents[0].id, 'All good.')).toBeNull();

      expect(run.agents[0].state).toBe('done');
      expect(run.state).toBe('finished');
      expect(run.endedAt).toBe(h.clock.now);
      expect(run.report?.incomplete).toBe(false);
      expect(run.report?.text).toContain('All good.');
      expect(h.ended).toEqual([run]);
      expect(h.notices.map((notice) => notice.kind)).toContain('report-ready');
    });

    it('waits for every agent', async () => {
      const run = await workingRun();

      h.manager.finishAgent(run.id, run.agents[0].id, 'One.');

      expect(run.state).toBe('running');
    });

    it('refuses an empty summary', async () => {
      const run = await workingRun(ONE_AGENT);

      expect(h.manager.finishAgent(run.id, run.agents[0].id, '   ')).toContain('empty');
      expect(run.agents[0].state).toBe('working');
    });

    it('refuses a second finish', async () => {
      const run = await workingRun();
      h.manager.finishAgent(run.id, run.agents[0].id, 'One.');

      expect(h.manager.finishAgent(run.id, run.agents[0].id, 'Two.')).toContain('already');
      expect(run.agents[0].summary).toBe('One.');
    });

    it('stops reminding once an agent finished', async () => {
      const run = await workingRun();
      h.manager.finishAgent(run.id, run.agents[0].id, 'One.');

      expect(h.manager.onTurnEnd(paneOf(run, 0))).toBeNull();
    });
  });

  describe('last agent', () => {
    it('starts only after the others finish', async () => {
      const run = await workingRun(WITH_JUDGE);

      h.manager.finishAgent(run.id, run.agents[0].id, 'One.');

      expect(run.agents[2].state).toBe('pending');
      expect(h.opened).toHaveLength(2);

      h.manager.finishAgent(run.id, run.agents[1].id, 'Two.');
      await flush();

      expect(run.agents[2].state).toBe('starting');
      expect(h.opened).toHaveLength(3);
      expect(h.manager.identify(paneOf(run, 2))).toMatchObject({ kind: 'last' });
    });

    it('gives the report from its summary', async () => {
      const run = await workingRun(WITH_JUDGE);
      h.manager.finishAgent(run.id, run.agents[0].id, 'One.');
      h.manager.finishAgent(run.id, run.agents[1].id, 'Two.');
      await flush();

      h.manager.finishAgent(run.id, run.agents[2].id, 'The full report.');

      expect(run.state).toBe('finished');
      expect(run.report).toMatchObject({ text: 'The full report.', incomplete: false });
    });

    it('is skipped when no other agent finished', async () => {
      const run = await workingRun(WITH_JUDGE);

      h.manager.skip(run.id, run.agents[0].id);
      h.manager.skip(run.id, run.agents[1].id);

      expect(run.agents[2].state).toBe('skipped');
      expect(run.state).toBe('finished');
      expect(h.opened).toHaveLength(2);
    });

    it('starts after a skip when another agent finished', async () => {
      const run = await workingRun(WITH_JUDGE);

      h.manager.finishAgent(run.id, run.agents[0].id, 'One.');
      h.manager.skip(run.id, run.agents[1].id);
      await flush();

      expect(run.agents[2].state).toBe('starting');
    });
  });

  describe('a pane closes', () => {
    it('fails the agent when a person closed it', async () => {
      const run = await workingRun();

      h.manager.onPaneClosed(paneOf(run, 0), true);

      expect(run.agents[0].state).toBe('failed');
      expect(run.agents[0].note).toBe('A person closed its pane.');
      expect(run.agents[0].paneId).toBeNull();
      expect(run.state).toBe('needs-you');
      expect(h.opened).toHaveLength(2);
    });

    it('retries once when the pane exits by itself', async () => {
      const run = await workingRun();
      const oldPane = paneOf(run, 0);

      h.manager.onPaneClosed(oldPane, false);
      await flush();

      expect(run.agents[0].state).toBe('starting');
      expect(run.agents[0].attempt).toBe(2);
      expect(run.agents[0].autoRetried).toBe(true);
      expect(h.opened).toHaveLength(3);
      expect(h.opened[2].line).toContain('--session');
      expect(h.opened[2].line).toContain('Fleet restarted you.');
    });

    it('fails the agent the second time', async () => {
      const run = await workingRun();
      h.manager.onPaneClosed(paneOf(run, 0), false);
      await flush();

      h.manager.onPaneClosed(paneOf(run, 0), false);
      await flush();

      expect(run.agents[0].state).toBe('failed');
      expect(run.state).toBe('needs-you');
      expect(h.opened).toHaveLength(3);
    });

    it('refuses calls from an older attempt', async () => {
      const run = await workingRun();
      const oldPane = paneOf(run, 0);

      await h.manager.retry(run.id, run.agents[0].id);

      expect(h.manager.identify(oldPane)).toEqual({ kind: 'old-attempt' });
      expect(h.killed).toContain(oldPane);
    });

    it('leaves a finished agent alone', async () => {
      const run = await workingRun();
      h.manager.finishAgent(run.id, run.agents[0].id, 'One.');

      h.manager.onPaneClosed(paneOf(run, 0), true);

      expect(run.agents[0].state).toBe('done');
      expect(run.state).toBe('running');
    });
  });

  describe('noticeIsCurrent', () => {
    const notice = (kind: WorkflowNotice['kind']): WorkflowNotice => ({
      id: 'n1',
      kind,
      text: 'text',
      runId: 'r1',
      projectPath: null
    });

    it('keeps a needs-you notice from the moment an agent needs a person', async () => {
      const run = await workingRun(ONE_AGENT);

      expect(noticeIsCurrent(notice('needs-you'), run)).toBe(false);

      run.agents[0].needsPerson = true;

      expect(noticeIsCurrent(notice('needs-you'), run)).toBe(true);
    });

    it('drops an agent-start notice when its run ends', async () => {
      const run = await workingRun(ONE_AGENT);

      expect(noticeIsCurrent(notice('agent-start'), run)).toBe(true);

      h.manager.stop(run.id);

      expect(noticeIsCurrent(notice('agent-start'), run)).toBe(false);
    });

    it('keeps other notices after a run ends', () => {
      expect(noticeIsCurrent(notice('report-ready'), undefined)).toBe(true);
    });

    it('keeps a notice that has no run', () => {
      expect(noticeIsCurrent({ ...notice('report-ready'), runId: null }, undefined)).toBe(true);
    });

    it('drops a queued notice when the run leaves the queue', async () => {
      const run = await workingRun(ONE_AGENT);

      expect(noticeIsCurrent(notice('queued'), { ...run, state: 'queued' })).toBe(true);
      expect(noticeIsCurrent(notice('queued'), run)).toBe(false);
    });

    it('drops a limit notice when the limit no longer holds', async () => {
      const run = await workingRun(ONE_AGENT);

      expect(noticeIsCurrent(notice('limit'), run)).toBe(false);

      run.limitReachedAt = 1;

      expect(noticeIsCurrent(notice('limit'), run)).toBe(true);
    });

    it('drops a report notice when the run is closed', async () => {
      const run = await workingRun(ONE_AGENT);

      expect(noticeIsCurrent(notice('report-ready'), run)).toBe(true);

      h.manager.close(run.id, false);

      expect(noticeIsCurrent(notice('report-ready'), run)).toBe(false);
    });
  });

  describe('a person answers a permission', () => {
    it('clears the question before the hook reports back', async () => {
      const run = await workingRun(ONE_AGENT);
      h.manager.onPermission(paneOf(run, 0), 'tool-1', 'Bash');
      expect(run.agents[0].pendingPermission?.toolUseId).toBe('tool-1');

      h.manager.onPermissionAnswered('tool-1');

      expect(run.agents[0].pendingPermission).toBeNull();
      expect(run.agents[0].needsPerson).toBe(false);
      expect(run.agents[0].state).toBe('working');
    });

    it('leaves a stopped agent stopped', async () => {
      const run = await workingRun(ONE_AGENT);
      h.manager.onPermission(paneOf(run, 0), 'tool-1', 'Bash');
      h.manager.stop(run.id);

      h.manager.onPermissionAnswered('tool-1');

      expect(run.agents[0].pendingPermission).toBeNull();
      expect(run.agents[0].state).toBe('failed');
    });

    it('leaves a skipped agent skipped', async () => {
      const run = await workingRun();
      h.manager.onPermission(paneOf(run, 0), 'tool-1', 'Bash');
      h.manager.skip(run.id, run.agents[0].id);

      h.manager.onPermissionAnswered('tool-1');

      expect(run.agents[0].state).toBe('skipped');
    });

    it('leaves an agent that waits on another tool', async () => {
      const run = await workingRun(ONE_AGENT);
      h.manager.onPermission(paneOf(run, 0), 'tool-1', 'Bash');

      h.manager.onPermissionAnswered('tool-2');

      expect(run.agents[0].pendingPermission?.toolUseId).toBe('tool-1');
    });
  });

  describe('live status', () => {
    it('shows a retry before the new pane opens', async () => {
      const run = await workingRun(ONE_AGENT);
      h.manager.onPaneClosed(paneOf(run, 0), true);
      const slow = deferredOpen();
      const states: string[] = [];
      h.deps.onRun = (changed) => states.push(changed.agents[0].state);

      const retrying = h.manager.retry(run.id, run.agents[0].id);
      await flush();

      expect(states).toContain('starting');
      slow.resolve();
      await retrying;
    });

    it('shows Go on before the panes open', async () => {
      const run = await workingRun(ONE_AGENT);
      h.manager.stop(run.id);
      run.state = 'cut-off';
      const slow = deferredOpen();
      const states: string[] = [];
      h.deps.onRun = (changed) => states.push(changed.state);

      const going = h.manager.goOn(run.id);
      await flush();

      expect(states).toContain('running');
      slow.resolve();
      await going;
    });
  });

  describe('start deadline', () => {
    it('asks a person about a late agent, and goes on when it starts', async () => {
      const run = await startRun(h, makePlan(ONE_AGENT));

      await h.advance(START_DEADLINE_MS - 1000);

      expect(run.agents[0].state).toBe('starting');

      await h.advance(1000);

      expect(run.agents[0].state).toBe('starting');
      expect(run.agents[0].needsPerson).toBe(true);
      expect(run.state).toBe('needs-you');

      const paneId = run.agents[0].paneId ?? '';
      h.manager.onSessionStart(paneId, { id: 's1', transcriptPath: null });

      expect(run.agents[0].state).toBe('working');
      expect(run.agents[0].needsPerson).toBe(false);
      expect(run.agents[0].note).toBeNull();
      expect(run.state).toBe('running');
    });

    it('fails a late agent in an automatic run, as nobody can answer', async () => {
      const run = await startRun(h, makePlan(ONE_AGENT, { origin: 'automatic' }));

      await h.advance(START_DEADLINE_MS);

      expect(run.agents[0].state).toBe('failed');
      expect(run.agents[0].note).toBe('It did not start in time.');
    });

    it('does not fail an agent that started', async () => {
      const run = await workingRun(ONE_AGENT);

      await h.advance(START_DEADLINE_MS * 2);

      expect(run.agents[0].state).toBe('working');
    });
  });

  describe('silence', () => {
    it('flags a silent agent and never fails it', async () => {
      h = makeHarness(dir, { lastOutputAt: () => START_TIME });
      const run = await workingRun(ONE_AGENT);

      await h.advance(SILENCE_MS);

      expect(run.agents[0].silent).toBe(true);
      expect(run.agents[0].state).toBe('working');
      expect(run.state).toBe('needs-you');
    });

    it('starts the count again after a sleep', async () => {
      h = makeHarness(dir, { lastOutputAt: () => START_TIME });
      const run = await workingRun(ONE_AGENT);

      h.manager.suspend();
      h.clock.now += SILENCE_MS * 2;
      h.manager.resume();
      await h.advance(1000);

      expect(run.agents[0].silent).toBe(false);
      expect(run.state).toBe('running');
    });

    it('counts again after Keep waiting', async () => {
      h = makeHarness(dir, { lastOutputAt: () => START_TIME });
      const run = await workingRun(ONE_AGENT);
      await h.advance(SILENCE_MS);

      h.manager.keepWaiting(run.id, run.agents[0].id);

      expect(run.agents[0].silent).toBe(false);
      expect(run.state).toBe('running');
    });
  });

  describe('stop', () => {
    it('writes an Incomplete report that names missing agents', async () => {
      const run = await workingRun(WITH_JUDGE);
      h.manager.finishAgent(run.id, run.agents[0].id, 'One.');
      const panes = [paneOf(run, 0), paneOf(run, 1)];

      h.manager.stop(run.id);

      expect(run.state).toBe('stopped');
      expect(run.report?.incomplete).toBe(true);
      expect(run.report?.missing).toEqual(['Second', 'Judge']);
      expect(run.report?.text).toContain('# Incomplete report');
      expect(run.report?.text).toContain('A person stopped this run.');
      expect(run.report?.text).toContain('These agents did not finish: Second, Judge.');
      expect(run.report?.text).toContain('## First\n\nOne.');
      expect(h.killed).toEqual(panes);
      expect(h.ended).toEqual([run]);
    });

    it('does nothing for a run that ended', async () => {
      const run = await workingRun(ONE_AGENT);
      h.manager.finishAgent(run.id, run.agents[0].id, 'Done.');

      h.manager.stop(run.id);

      expect(run.state).toBe('finished');
      expect(h.ended).toHaveLength(1);
    });
  });

  describe('a new launch', () => {
    it('marks stored active runs as cut off', async () => {
      const run = await workingRun();
      h.manager.addFinding(run.id, run.agents[0].id, { kind: 'bug', text: 'one' });

      const manager = h.relaunch();
      const stored = manager.get(run.id);

      expect(stored?.state).toBe('cut-off');
      expect(stored?.agents.map((agent) => agent.state)).toEqual(['failed', 'failed']);
      expect(stored?.agents[0].note).toBe('Fleet closed during this run.');
      expect(stored?.agents[0].paneId).toBeNull();
      expect(stored?.board.map((item) => item.text)).toEqual(['one']);
      expect(h.relaunch().get(run.id)?.state).toBe('cut-off');
    });

    it('leaves an ended run as it is', async () => {
      const run = await workingRun(ONE_AGENT);
      h.manager.finishAgent(run.id, run.agents[0].id, 'Done.');

      expect(h.relaunch().get(run.id)?.state).toBe('finished');
    });

    it('goes on from the old transcripts', async () => {
      const run = await workingRun();
      h.manager.markCutOff();
      const manager = h.relaunch();

      await manager.goOn(run.id);

      expect(manager.get(run.id)?.state).toBe('running');
      expect(h.opened.slice(2).map((pane) => pane.line)).toEqual([
        expect.stringContaining('/transcripts/First.jsonl'),
        expect.stringContaining('/transcripts/Second.jsonl')
      ]);
    });
  });

  describe('after the end', () => {
    it('ignores an API failure in a follow-up turn', async () => {
      const run = await workingRun(ONE_AGENT);
      const pane = paneOf(run, 0);
      h.manager.finishAgent(run.id, run.agents[0].id, 'Done.');
      const opened = h.opened.length;

      h.manager.onApiFailure(pane, 'overloaded');
      await flush();

      expect(run.agents[0].state).toBe('done');
      expect(h.opened).toHaveLength(opened);
    });

    it('does not reopen an agent of an ended run', async () => {
      const run = await workingRun(ONE_AGENT);
      h.manager.stop(run.id);
      const opened = h.opened.length;

      await h.manager.retry(run.id, run.agents[0].id);

      expect(h.opened).toHaveLength(opened);
    });

    it('refuses a kept pane as an old attempt, so it gets no outside tools', async () => {
      const run = await workingRun(ONE_AGENT, { origin: 'automatic' });
      const pane = paneOf(run, 0);
      h.manager.onPersonInput(pane, 'x');

      finishAll(run);

      expect(h.manager.identify(pane)).toEqual({ kind: 'old-attempt' });
    });

    it('keeps the team PR mode through a restart', async () => {
      const def = makeDef({ workspace: 'pr-worktree' });
      const run = await workingRun(def, { pr: SAMPLE_PR, teamPr: true });
      h.manager.markCutOff();
      const manager = h.relaunch();
      const opened = h.opened.length;

      await manager.goOn(run.id);

      expect(manager.get(run.id)?.teamPr).toBe(true);
      expect(h.opened[opened].line).toContain('--approve');
    });
  });

  describe('report guarantee', () => {
    it('gives a report when an agent dies with no finish call', async () => {
      const run = await workingRun(ONE_AGENT);
      h.manager.addFinding(run.id, run.agents[0].id, { kind: 'bug', text: 'on the board' });
      h.manager.onPaneClosed(paneOf(run, 0), false);
      await flush();

      h.manager.onPaneClosed(paneOf(run, 0), false);
      await flush();

      expect(run.state).toBe('finished');
      expect(run.report?.incomplete).toBe(true);
      expect(run.report?.missing).toEqual(['Solo']);
      expect(run.report?.text).toContain('on the board');
      expect(h.ended).toEqual([run]);
    });

    it('gives a report when a person skips every agent', async () => {
      const run = await workingRun();

      h.manager.skip(run.id, run.agents[0].id);
      h.manager.skip(run.id, run.agents[1].id);

      expect(run.state).toBe('finished');
      expect(run.report?.text).not.toBe('');
    });

    it('drops merged items from the report', async () => {
      const run = await workingRun(WITH_JUDGE);
      const judge = run.agents[2];
      h.manager.addFinding(run.id, run.agents[0].id, { kind: 'bug', text: 'old text' });
      h.manager.finishAgent(run.id, run.agents[0].id, 'One.');
      h.manager.finishAgent(run.id, run.agents[1].id, 'Two.');
      await flush();
      h.manager.mergeFindings(run.id, judge.id, ['1'], { kind: 'bug', text: 'new text' });

      h.manager.stop(run.id);

      expect(run.report?.text).toContain('new text');
      expect(run.report?.text).not.toContain('old text');
    });
  });

  describe('board', () => {
    it('keeps items on disk for the next launch', async () => {
      const run = await workingRun();
      h.manager.addFinding(run.id, run.agents[0].id, { kind: 'bug', text: 'one' });
      h.manager.addFinding(run.id, run.agents[1].id, { kind: 'bug', text: 'two' });

      h.manager.mergeFindings(run.id, run.agents[0].id, ['1', '2'], { kind: 'bug', text: 'both' });

      const stored = h.relaunch().get(run.id);

      expect(stored?.board.map((item) => item.mergedInto)).toEqual(['3', '3', undefined]);
      expect(h.manager.listFindings(run.id).map((item) => item.id)).toEqual(['3']);
    });
  });

  describe('sleep', () => {
    it('does not count sleep in active time', async () => {
      const run = await workingRun(ONE_AGENT);
      await h.advance(30_000);
      const before = run.activeMs;

      h.manager.suspend();
      h.clock.now += 3_600_000;
      h.manager.tick();
      h.manager.resume();
      await h.advance(30_000);

      expect(before).toBe(30_000);
      expect(run.activeMs).toBe(60_000);
      expect(run.sleptMs).toBe(3_600_000);
    });

    it('treats a long gap between ticks as sleep', async () => {
      const run = await workingRun(ONE_AGENT);

      h.clock.now += 3_600_000;
      h.manager.tick();

      expect(run.activeMs).toBe(0);
      expect(run.sleptMs).toBe(3_600_000);
    });

    it('does not spend the start deadline while asleep', async () => {
      const run = await startRun(h, makePlan(ONE_AGENT));

      h.manager.suspend();
      h.clock.now += 3_600_000;
      h.manager.resume();
      await h.advance(30_000);

      expect(run.agents[0].state).toBe('starting');
    });

    it('does not spend the start deadline in a gap between ticks', async () => {
      const run = await startRun(h, makePlan(ONE_AGENT));

      h.clock.now += 3_600_000;
      h.manager.tick();

      expect(run.agents[0].state).toBe('starting');
    });

    it('does not spend the limit grace while asleep', async () => {
      const run = await workingRun(ONE_AGENT);
      await h.advance(DEFAULT_LIMIT_MS);
      expect(run.limitReachedAt).not.toBeNull();

      h.manager.suspend();
      h.clock.now += 3_600_000;
      h.manager.resume();
      await h.advance(30_000);

      expect(run.state).not.toBe('stopped');
    });
  });

  describe('time limit', () => {
    it('warns at the limit and stops after the grace', async () => {
      const run = await workingRun(ONE_AGENT);

      await h.advance(DEFAULT_LIMIT_MS);

      expect(run.limitReachedAt).toBe(h.clock.now);
      expect(h.notices.filter((notice) => notice.kind === 'limit')).toHaveLength(1);
      expect(run.state).toBe('running');

      await h.advance(LIMIT_GRACE_MS - 30_000);

      expect(run.state).toBe('running');

      await h.advance(30_000);

      expect(run.state).toBe('stopped');
      expect(run.report?.text).toContain('nobody added time');
    });

    it('goes on after a person adds time', async () => {
      const run = await workingRun(ONE_AGENT);
      await h.advance(DEFAULT_LIMIT_MS);

      h.manager.addTime(run.id);
      await h.advance(LIMIT_GRACE_MS);

      expect(run.state).toBe('running');
      expect(run.limitReachedAt).toBeNull();
      expect(run.limitMs).toBe(DEFAULT_LIMIT_MS + ADD_TIME_MS);
    });

    it('stops an automatic run with no grace', async () => {
      const run = await workingRun(ONE_AGENT, { origin: 'automatic' });

      await h.advance(DEFAULT_LIMIT_MS);

      expect(run.state).toBe('stopped');
      expect(run.report?.text).toContain('time limit');
    });
  });

  describe('the end of a run', () => {
    it('closes the panes of a run a person started', async () => {
      const run = await workingRun(ONE_AGENT);

      finishAll(run);

      expect(run.state).toBe('finished');
      expect(run.agents[0].paneId).toBeNull();
      expect(h.killed).toHaveLength(1);
    });

    it('closes panes but keeps one a person typed in', async () => {
      const removed: string[] = [];
      h = makeHarness(dir, {
        removeWorktree: async (run) => {
          removed.push(run.id);
          return Promise.resolve();
        }
      });
      const def = makeDef({ workspace: 'pr-worktree' });
      const run = await workingRun(def, { origin: 'automatic', pr: SAMPLE_PR });
      const [typed, other] = [paneOf(run, 0), paneOf(run, 1)];
      h.manager.onPersonInput(typed, 'x');

      finishAll(run);

      expect(run.keptPanes).toEqual([typed]);
      expect(run.agents[0].keptPaneId).toBe(typed);
      expect(h.killed).toEqual([other]);
      expect(removed).toEqual([]);

      h.manager.onPaneClosed(typed, true);

      expect(run.keptPanes).toEqual([]);
      expect(run.agents[0].keptPaneId).toBeNull();
      expect(removed).toEqual([run.id]);
    });

    it('does not take a terminal reply as a person typing', async () => {
      const run = await workingRun(ONE_AGENT);
      h.manager.onPersonInput(paneOf(run, 0), '\x1b[?1;2c');

      finishAll(run);

      expect(run.agents[0].personTyped).toBe(false);
      expect(run.keptPanes).toEqual([]);
    });

    it('forgets kept panes after a restart, as Fleet killed them', async () => {
      const removed: string[] = [];
      h = makeHarness(dir, {
        removeWorktree: async (run) => {
          removed.push(run.id);
          return Promise.resolve();
        }
      });
      const run = await workingRun(makeDef({ workspace: 'pr-worktree' }), { pr: SAMPLE_PR });
      h.manager.onPersonInput(paneOf(run, 0), 'x');
      finishAll(run);

      const adopted = h.relaunch().get(run.id);

      expect(adopted?.keptPanes).toEqual([]);
      expect(adopted?.agents[0].keptPaneId).toBeNull();
      expect(removed).toEqual([run.id]);
    });
  });

  describe('openAgent', () => {
    function hasChat(run: WorkflowRun): void {
      h.manager.onSessionStart(paneOf(run, 0), { id: 'chat-1', transcriptPath: '/chat.jsonl' });
    }

    it('opens the old chat in a pane that waits for a person', async () => {
      const run = await workingRun(ONE_AGENT);
      hasChat(run);
      finishAll(run);
      const opened = h.opened.length;

      const reply = await h.manager.openAgent(run.id, run.agents[0].id);

      expect(reply.ok).toBe(true);
      expect(run.state).toBe('finished');
      expect(h.opened).toHaveLength(opened + 1);
      const { line } = h.opened[opened];
      expect(line).toContain('/chat.jsonl');
      expect(line).not.toContain('Start now');
      expect(run.keptPanes).toHaveLength(1);
      expect(h.manager.identify(run.keptPanes[0])).toEqual({ kind: 'old-attempt' });
    });

    it('shows the pane it already has', async () => {
      const run = await workingRun(ONE_AGENT);
      hasChat(run);
      finishAll(run);
      const first = await h.manager.openAgent(run.id, run.agents[0].id);
      const opened = h.opened.length;

      expect(await h.manager.openAgent(run.id, run.agents[0].id)).toEqual(first);
      expect(h.opened).toHaveLength(opened);
    });

    it('makes the worktree again on the same commit', async () => {
      const pins: Array<string | undefined> = [];
      h = makeHarness(dir, {
        makeWorktree: async (_run, pinnedSha) => {
          pins.push(pinnedSha);
          return Promise.resolve({ path: '/worktrees/run', sha: 'first' });
        }
      });
      const run = await workingRun(makeDef({ workspace: 'pr-worktree' }), { pr: SAMPLE_PR });
      hasChat(run);
      finishAll(run);
      expect(run.worktreePath).toBeNull();

      await h.manager.openAgent(run.id, run.agents[0].id);

      expect(pins).toEqual([undefined, 'first']);
      expect(run.worktreePath).toBe('/worktrees/run');
      expect(run.pr?.headSha).toBe('first');
    });

    it('says why when the worktree cannot come back', async () => {
      let calls = 0;
      h = makeHarness(dir, {
        makeWorktree: async () => {
          calls += 1;
          if (calls === 2) return Promise.reject(new Error('commit is gone'));
          return Promise.resolve({ path: '/worktrees/run', sha: 'first' });
        }
      });
      const run = await workingRun(makeDef({ workspace: 'pr-worktree' }), { pr: SAMPLE_PR });
      hasChat(run);
      finishAll(run);

      expect(await h.manager.openAgent(run.id, run.agents[0].id)).toEqual({
        ok: false,
        reason: 'commit is gone'
      });
    });

    it('refuses a live run and an agent with no chat', async () => {
      const run = await workingRun(ONE_AGENT);

      expect((await h.manager.openAgent(run.id, run.agents[0].id)).ok).toBe(false);

      finishAll(run);
      run.agents[0].transcriptPath = null;

      expect(await h.manager.openAgent(run.id, run.agents[0].id)).toEqual({
        ok: false,
        reason: 'This agent has no chat to open.'
      });
    });
  });

  describe('close', () => {
    it('stops the run and removes the worktree when asked', async () => {
      const removed: string[] = [];
      h = makeHarness(dir, {
        removeWorktree: async (run) => {
          removed.push(run.id);
          return Promise.resolve();
        }
      });
      const def = makeDef({ workspace: 'pr-worktree' });
      const run = await workingRun(def, { pr: SAMPLE_PR });

      h.manager.close(run.id, true);

      expect(run.state).toBe('closed');
      expect(run.report?.incomplete).toBe(true);
      expect(removed).toEqual([run.id]);
      expect(run.cwd).toBe('/repo');
    });
  });
});

describe('buildReport', () => {
  const agent = {
    id: 'a',
    role: 'Worker',
    program: 'pi' as const,
    isLast: false,
    state: 'done' as const,
    paneId: null,
    attempt: 1,
    summary: 'Worker notes.',
    note: null,
    reminded: false,
    needsPerson: false,
    silent: false,
    personTyped: false,
    keptPaneId: null,
    autoRetried: false,
    sessionId: null,
    transcriptPath: null,
    pendingPermission: null
  };

  it('joins summaries when there is no last agent', () => {
    const report = buildReport(makeRun({ agents: [agent] }));

    expect(report).toEqual({
      text: '## Worker\n\nWorker notes.',
      incomplete: false,
      posted: false,
      missing: [],
      savedTo: null
    });
  });

  it('says so when nothing was done', () => {
    const report = buildReport(makeRun({ agents: [{ ...agent, summary: null }] }));

    expect(report.incomplete).toBe(true);
    expect(report.text).toContain('Nothing was finished');
  });

  it('leaves skipped agents out of the missing list', () => {
    const skipped = { ...agent, id: 'b', role: 'Other', state: 'skipped' as const, summary: null };

    expect(buildReport(makeRun({ agents: [agent, skipped] })).missing).toEqual([]);
  });
});
