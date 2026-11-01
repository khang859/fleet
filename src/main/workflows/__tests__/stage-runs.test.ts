import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  RunAgent,
  WorkflowAgentDef,
  WorkflowDef,
  WorkflowRun,
  WorkflowStageDef
} from '../../../shared/workflows';
import { DEFAULT_LIMIT_MS } from '../run-manager';
import {
  agentDef,
  flush,
  makeDef,
  makeHarness,
  makePlan,
  paneOf,
  sessionsUp,
  startRun,
  type Harness
} from './helpers';

function agent(
  role: string,
  program: WorkflowAgentDef['program'],
  extra: Partial<WorkflowAgentDef> = {}
): WorkflowAgentDef {
  return { ...agentDef(role, program), access: 'read', ...extra };
}

function stageFile(stages: WorkflowStageDef[], extra: Partial<WorkflowDef> = {}): WorkflowDef {
  return makeDef({ agents: [], stages, ...extra });
}

const LEAD = agent('Lead', 'claude', { access: 'write', talks: true, plan: true });
const PI_LEAD = agent('Lead', 'pi', { access: 'write', talks: true, plan: true });

const FEATURE: WorkflowStageDef[] = [
  { name: 'Build', agents: [LEAD] },
  { name: 'Review', agents: [agent('Bugs', 'pi'), agent('Tests', 'pi')] },
  {
    name: 'Fix',
    only_with_findings: true,
    agents: [agent('Lead', 'claude', { access: 'write', resume: 'Lead' })]
  }
];

describe('stage runs', () => {
  let dir: string;
  let h: Harness;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fleet-wf-stages-'));
    h = makeHarness(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function started(def: WorkflowDef, plan = {}): Promise<WorkflowRun> {
    h.deps.parse = () => def;
    const run = await startRun(h, makePlan(def, plan));
    sessionsUp(h, run);
    return run;
  }

  function byRole(run: WorkflowRun, role: string): RunAgent {
    const found = run.agents.find((candidate) => candidate.role === role);
    if (!found) throw new Error(`No agent ${role}.`);
    return found;
  }

  function finishAll(run: WorkflowRun, stage: number): void {
    for (const each of run.agents.filter((candidate) => candidate.stage === stage)) {
      h.manager.finishAgent(run.id, each.id, `${each.role} is done.`);
    }
  }

  /** The Lead's plan, approved, so that the Lead can finish. */
  async function approved(run: WorkflowRun): Promise<RunAgent> {
    const lead = run.agents[0];
    h.manager.onPermission(paneOf(run, 0), 'tool-1', 'ExitPlanMode', '# Plan');
    await h.manager.answerPlan(run.id, lead.id, { kind: 'approve', mode: 'acceptEdits' });
    return lead;
  }

  describe('order', () => {
    it('opens only the first stage', async () => {
      await started(stageFile(FEATURE));

      expect(h.opened).toHaveLength(1);
    });

    it('starts the next stage when the stage before it is done', async () => {
      const run = await started(stageFile(FEATURE));
      await approved(run);

      finishAll(run, 0);
      await flush();

      expect(h.opened).toHaveLength(3);
      expect(run.state).toBe('running');
    });

    it('holds the next stage while one agent still works', async () => {
      const stages = [
        { name: 'One', agents: [agent('A', 'pi'), agent('B', 'pi')] },
        { name: 'Two', agents: [agent('C', 'pi')] }
      ];
      const run = await started(stageFile(stages));

      h.manager.finishAgent(run.id, run.agents[0].id, 'Done.');
      await flush();

      expect(h.opened).toHaveLength(2);
    });

    it('holds the next stage when an agent fails, and asks a person', async () => {
      const stages = [
        { name: 'One', agents: [agent('A', 'pi'), agent('B', 'pi')] },
        { name: 'Two', agents: [agent('C', 'pi')] }
      ];
      const run = await started(stageFile(stages));

      h.manager.finishAgent(run.id, run.agents[0].id, 'Done.');
      h.manager.onApiFailure(paneOf(run, 1), 'quota');
      h.manager.onApiFailure(paneOf(run, 1), 'quota');
      await h.advance(1_000);

      expect(h.opened.length).toBeLessThanOrEqual(3);
      expect(byRole(run, 'C').state).toBe('pending');
    });

    it('gives an incomplete report when every reviewer failed', async () => {
      const stages = [
        { name: 'Build', agents: [agent('Lead', 'pi', { access: 'write' })] },
        { name: 'Review', agents: [agent('Bugs', 'pi')] },
        { name: 'Fix', only_with_findings: true, agents: [agent('Fix', 'pi')] }
      ];
      const run = await started(stageFile(stages, { board: true }));
      h.manager.finishAgent(run.id, run.agents[0].id, 'Built.');
      await flush();
      sessionsUp(h, run);

      for (let tries = 0; tries < 2; tries += 1) {
        h.manager.onApiFailure(paneOf(run, 1), 'quota');
        await h.advance(1_000);
        sessionsUp(h, run);
      }

      expect(run.state).toBe('finished');
      expect(run.report?.incomplete).toBe(true);
      expect(run.report?.text).toContain('Built.');
      expect(run.report?.missing).toEqual(['Bugs']);
    });

    it('holds a later stage until the agent limit has room', async () => {
      h = makeHarness(dir, { maxAgents: () => 2 });
      const other = await started(stageFile([{ name: 'One', agents: [agent('Other', 'pi')] }]));
      const stages = [
        { name: 'One', agents: [agent('Lead', 'pi', { access: 'write' })] },
        { name: 'Two', agents: [agent('A', 'pi'), agent('B', 'pi')] }
      ];
      const run = await started(stageFile(stages));

      h.manager.finishAgent(run.id, run.agents[0].id, 'Built.');
      await flush();

      expect(byRole(run, 'A').state).toBe('pending');
      expect(run.problem).toContain('Waiting for room');

      h.manager.finishAgent(other.id, other.agents[0].id, 'Done.');
      await h.advance(1_000);

      expect(byRole(run, 'A').state).not.toBe('pending');
      expect(run.problem).toBeNull();
    });

    it('skips a stage with no findings, and finishes', async () => {
      const run = await started(stageFile(FEATURE));
      await approved(run);
      finishAll(run, 0);
      await flush();

      finishAll(run, 1);
      await flush();

      expect(run.agents[3].state).toBe('skipped');
      expect(run.state).toBe('finished');
      expect(run.report?.text).toContain('Lead is done.');
    });

    it('runs the stage when the board has a finding', async () => {
      const run = await started(stageFile(FEATURE));
      await approved(run);
      finishAll(run, 0);
      await flush();
      h.manager.addFinding(run.id, run.agents[1].id, { kind: 'bug', text: 'Off by one.' });

      finishAll(run, 1);
      await flush();

      expect(run.agents[3].state).not.toBe('skipped');
      expect(h.opened).toHaveLength(4);
    });

    it('resumes the session of the named agent', async () => {
      const run = await started(stageFile(FEATURE));
      await approved(run);
      finishAll(run, 0);
      await flush();
      h.manager.addFinding(run.id, run.agents[1].id, { kind: 'bug', text: 'Off by one.' });

      finishAll(run, 1);
      await flush();

      expect(h.opened.at(-1)?.line).toContain("'--resume' 'session-Lead'");
    });

    it('writes the diff for readers, and names it in their brief', async () => {
      const run = await started(stageFile(FEATURE));
      await approved(run);

      finishAll(run, 0);
      await flush();

      const [, path] = /'--append-system-prompt' '([^']+)'/.exec(h.opened[1].line) ?? [];
      const brief = readFileSync(path, 'utf8');
      expect(brief).toContain('changes.diff');
      expect(brief).toContain(join('plans', '1.md'));
    });
  });

  describe('talking agents', () => {
    const talker: WorkflowStageDef[] = [
      { name: 'Talk', agents: [agent('Talker', 'pi', { talks: true })] }
    ];

    it('sends no reminder and asks a person', async () => {
      const run = await started(stageFile(talker));

      expect(h.manager.onTurnEnd(paneOf(run, 0))).toBeNull();

      expect(run.state).toBe('needs-you');
      expect(h.notices.some((notice) => notice.kind === 'needs-you')).toBe(true);
    });

    it('goes back to work on the next turn', async () => {
      const run = await started(stageFile(talker));
      h.manager.onTurnEnd(paneOf(run, 0));

      h.manager.onTurnStart(paneOf(run, 0));

      expect(run.state).toBe('running');
    });

    it('asks a person when Claude Code waits on a question', async () => {
      const stages = [{ name: 'Talk', agents: [agent('Talker', 'claude', { talks: true })] }];
      const run = await started(stageFile(stages));

      h.manager.onQuestion(paneOf(run, 0));

      expect(run.state).toBe('needs-you');
    });

    it('does not cut off a long wait', async () => {
      const run = await started(stageFile(talker));
      h.manager.onTurnEnd(paneOf(run, 0));

      await h.advance(DEFAULT_LIMIT_MS * 2);

      expect(run.state).toBe('needs-you');
      expect(run.problem).toBeNull();
    });
  });

  describe('plan on Claude Code', () => {
    const def = stageFile([{ name: 'Lead', agents: [LEAD] }]);

    it('starts in plan mode', async () => {
      await started(def);

      expect(h.opened[0].line).toContain("'--permission-mode' 'plan'");
    });

    it('saves the plan and waits', async () => {
      const run = await started(def);

      h.manager.onPermission(paneOf(run, 0), 'tool-1', 'ExitPlanMode', '# Plan');

      expect(run.state).toBe('needs-you');
      expect(run.agents[0].pendingPlan).toEqual({ version: 1, toolUseId: 'tool-1' });
      expect(h.manager.readPlan(run.id, 1)).toBe('# Plan');
    });

    it('sends the mode with an approval', async () => {
      const answers: unknown[][] = [];
      h.deps.answerRequest = (...args) => answers.push(args) > 0;
      const run = await started(def);

      await approved(run);

      expect(answers[0]).toEqual(['tool-1', 'allow', undefined, 'acceptEdits']);
      expect(run.agents[0].planApproved).toBe(true);
      expect(run.state).toBe('running');
    });

    it('sends the words of a change request, and keeps planning', async () => {
      const answers: unknown[][] = [];
      h.deps.answerRequest = (...args) => answers.push(args) > 0;
      const run = await started(def);
      h.manager.onPermission(paneOf(run, 0), 'tool-1', 'ExitPlanMode', '# Plan');

      await h.manager.answerPlan(run.id, run.agents[0].id, { kind: 'change', text: 'Smaller.' });

      expect(answers[0]).toEqual(['tool-1', 'deny', 'Smaller.']);
      expect(run.agents[0].planApproved).toBeFalsy();
    });

    it('stops waiting after an approval in the pane, and keeps the plan', async () => {
      const run = await started(def);
      h.manager.onPermission(paneOf(run, 0), 'tool-1', 'ExitPlanMode', '# Plan');

      h.manager.onTurnStart(paneOf(run, 0));
      h.manager.onToolDone(paneOf(run, 0), 'ExitPlanMode');

      expect(run.agents[0].planApproved).toBe(true);
      expect(run.agents[0].pendingPlan).toBeNull();
      expect(h.manager.readPlan(run.id, 1)).toBe('# Plan');
    });

    it('refuses a finish before approval', async () => {
      const run = await started(def);

      expect(h.manager.finishAgent(run.id, run.agents[0].id, 'Done.')).toContain('approve');
    });
  });

  describe('plan on Pi', () => {
    const def = stageFile([{ name: 'Lead', agents: [PI_LEAD] }]);

    it('starts with read tools only', async () => {
      await started(def);

      expect(h.opened[0].line).toContain("'--tools' 'read,grep,find,ls,fleet_*'");
      expect(h.opened[0].line).not.toContain('+edit');
    });

    it('keeps each plan, and shows the newest', async () => {
      const run = await started(def);
      const [lead] = run.agents;

      h.manager.submitPlan(run.id, lead.id, 'One');
      h.manager.submitPlan(run.id, lead.id, 'Two');
      h.manager.onTurnEnd(paneOf(run, 0));

      expect(lead.pendingPlan?.version).toBe(2);
      expect(h.manager.readPlan(run.id, 1)).toBe('One');
      expect(run.state).toBe('needs-you');
    });

    it('opens Pi again with write tools after approval', async () => {
      const run = await started(def);
      const [lead] = run.agents;
      h.manager.submitPlan(run.id, lead.id, 'Plan');
      h.manager.onTurnEnd(paneOf(run, 0));

      await h.manager.answerPlan(run.id, lead.id, { kind: 'approve' });

      expect(h.opened).toHaveLength(2);
      expect(h.opened[1].line).toContain("'--tools' '+edit,+write,+bash'");
      expect(h.opened[1].line).toContain('/transcripts/Lead.jsonl');
    });

    it('sends a change request to the same process', async () => {
      const sent: string[] = [];
      h.deps.sendPrompt = async (_, text) => {
        sent.push(text);
        return Promise.resolve(true);
      };
      const run = await started(def);
      const [lead] = run.agents;
      h.manager.submitPlan(run.id, lead.id, 'Plan');
      h.manager.onTurnEnd(paneOf(run, 0));

      await h.manager.answerPlan(run.id, lead.id, { kind: 'change', text: 'Smaller.' });

      expect(sent).toEqual(['Smaller.']);
      expect(h.opened).toHaveLength(1);
    });

    it('keeps the plan when a change request does not arrive', async () => {
      h.deps.sendPrompt = async () => Promise.resolve(false);
      const run = await started(def);
      const [lead] = run.agents;
      h.manager.submitPlan(run.id, lead.id, 'Plan');
      h.manager.onTurnEnd(paneOf(run, 0));

      const sent = await h.manager.answerPlan(run.id, lead.id, {
        kind: 'change',
        text: 'Smaller.'
      });

      expect(sent).toBe(false);
      expect(lead.pendingPlan?.version).toBe(1);
      expect(lead.state).not.toBe('working');
    });

    it('keeps the read limit after a restart with a plan that waits', async () => {
      const run = await started(def);
      const [lead] = run.agents;
      h.manager.submitPlan(run.id, lead.id, 'Plan');

      const after = h.relaunch();
      after.resume();
      await flush();

      expect(after.get(run.id)?.agents[0].pendingPlan?.version).toBe(1);
      expect(h.opened.slice(1).every((pane) => !pane.line.includes('+edit'))).toBe(true);
    });

    it('refuses a plan from an agent with no plan', async () => {
      const run = await started(stageFile([{ name: 'A', agents: [agent('A', 'pi')] }]));

      expect(h.manager.submitPlan(run.id, run.agents[0].id, 'Plan')).toContain('no plan');
    });

    it('refuses a plan after approval', async () => {
      const run = await started(def);
      const [lead] = run.agents;
      h.manager.submitPlan(run.id, lead.id, 'Plan');
      await h.manager.answerPlan(run.id, lead.id, { kind: 'approve' });

      expect(h.manager.submitPlan(run.id, lead.id, 'Again')).toContain('already approved');
    });
  });

  describe('new branch', () => {
    const def = stageFile([{ name: 'Lead', agents: [agent('Lead', 'pi', { access: 'write' })] }], {
      workspace: 'new-branch'
    });

    it('runs in the new worktree', async () => {
      const run = await started(def);

      expect(run.cwd).toBe('/worktrees/branch');
      expect(run.branch?.name).toBe('fleet/review');
    });

    it('does not start an agent when the branch fails', async () => {
      h.deps.makeBranch = async () => Promise.reject(new Error('no git'));

      const run = await startRun(h, makePlan(def));
      await h.advance(30_000);

      expect(run.problem).toContain('no git');
      expect(h.opened).toHaveLength(0);
    });

    it('keeps the worktree until the pull request opens', async () => {
      const removed: string[] = [];
      h.deps.removeWorktree = async (run) => {
        removed.push(run.id);
        return Promise.resolve();
      };
      const run = await started(def);

      h.manager.finishAgent(run.id, run.agents[0].id, 'Done.');
      await flush();

      expect(removed).toEqual([]);
      expect(run.worktreePath).toBe('/worktrees/branch');
    });

    it('notes the pull request', async () => {
      const run = await started(def);
      h.manager.finishAgent(run.id, run.agents[0].id, 'Done.');

      h.manager.notePrOpened(run.id, { number: 9, url: 'https://github.com/a/b/pull/9' });

      expect(run.openedPr?.number).toBe(9);
    });

    it('keeps the reason when no pull request opens', async () => {
      const run = await started(def);
      h.manager.finishAgent(run.id, run.agents[0].id, 'Done.');

      h.manager.notePrProblem(run.id, 'The branch has no commits.');

      expect(run.prProblem).toBe('The branch has no commits.');
      expect(run.worktreePath).toBe('/worktrees/branch');
    });
  });
});
