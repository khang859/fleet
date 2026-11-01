import { describe, expect, it } from 'vitest';
import type { RunAgent, WorkflowDef, WorkflowStageDef } from '../../../shared/workflows';
import {
  agentMode,
  noWayOn,
  onlyWaitsForPerson,
  permissionModeOf,
  reportAgent,
  runsLast,
  skipsItself,
  stageOf,
  stageToStart
} from '../stages';
import { agentDef, makeDef, makeRun } from './helpers';

const STAGES: WorkflowStageDef[] = [
  { name: 'Lead', agents: [agentDef('Lead')] },
  { name: 'Review', agents: [agentDef('A'), agentDef('B')] },
  { name: 'Fix', only_with_findings: true, agents: [agentDef('Lead')] }
];

const DEF: WorkflowDef = makeDef({ agents: [], stages: STAGES });

function agent(stage: number, state: RunAgent['state'], extra: Partial<RunAgent> = {}): RunAgent {
  return {
    id: 'agent',
    role: 'Agent',
    program: 'pi',
    isLast: false,
    state,
    paneId: null,
    sessionId: null,
    transcriptPath: null,
    summary: null,
    note: null,
    autoRetried: false,
    stage,
    ...extra
  } as RunAgent;
}

function runOf(agents: RunAgent[], extra = {}): ReturnType<typeof makeRun> {
  return { ...makeRun(), agents, stageFile: true, ...extra };
}

describe('stageOf', () => {
  it('puts the last agent of an older run after the others', () => {
    const { stage: _, ...old } = agent(0, 'done', { isLast: true });

    expect(stageOf(old)).toBe(1);
  });
});

describe('stageToStart', () => {
  it('starts the first stage with a pending agent', () => {
    const run = runOf([agent(0, 'done'), agent(1, 'pending'), agent(1, 'pending')]);

    expect(stageToStart(run, STAGES)).toBe(1);
  });

  it('waits while an agent of the stage works', () => {
    const run = runOf([agent(0, 'working'), agent(1, 'pending')]);

    expect(stageToStart(run, STAGES)).toBeNull();
  });

  it('waits on a failed agent', () => {
    const run = runOf([agent(0, 'failed'), agent(1, 'pending')]);

    expect(stageToStart(run, STAGES)).toBeNull();
  });
});

describe('noWayOn', () => {
  it('stops when every agent of a stage is lost', () => {
    const run = runOf([agent(0, 'failed', { autoRetried: true }), agent(1, 'pending')]);

    expect(noWayOn(run, STAGES)).toBe(true);
  });

  it('goes on past a stage that skipped itself', () => {
    const run = runOf([
      agent(0, 'done'),
      agent(1, 'done'),
      agent(1, 'done'),
      agent(2, 'skipped', { isLast: true })
    ]);

    expect(noWayOn(run, STAGES)).toBe(false);
  });
});

describe('skipsItself', () => {
  it('skips with an empty board', () => {
    expect(skipsItself(runOf([]), STAGES[2])).toBe(true);
  });

  it('counts only items that are not merged', () => {
    const item = { id: 'a', kind: 'bug', text: 'x', source: 'A', mergedInto: 'b' };
    const run = runOf([], { board: [item] });

    expect(skipsItself(run, STAGES[2])).toBe(true);
  });

  it('runs with a finding', () => {
    const run = runOf([], { board: [{ id: 'a', kind: 'bug', text: 'x', source: 'A' }] });

    expect(skipsItself(run, STAGES[2])).toBe(false);
  });
});

describe('runsLast', () => {
  it('picks the one agent of the last stage', () => {
    expect(runsLast(DEF, 2)).toBe(true);
    expect(runsLast(DEF, 1)).toBe(false);
  });

  it('picks nobody when the last stage has many agents', () => {
    const def = makeDef({ agents: [], stages: STAGES.slice(0, 2) });

    expect(runsLast(def, 1)).toBe(false);
  });

  it('picks the judge of an old file', () => {
    const def = makeDef({ judge: agentDef('Judge') });

    expect(runsLast(def, 1)).toBe(true);
  });
});

describe('agentMode', () => {
  const writer = agent(0, 'pending', { access: 'write', program: 'claude' });

  it('keeps the old modes for an old file', () => {
    expect(agentMode(makeRun(), makeDef(), writer)).toBe('normal');
    expect(agentMode({ ...makeRun(), teamPr: true }, makeDef(), writer)).toBe('team-pr');
  });

  it('lets the run lock win', () => {
    expect(agentMode({ ...makeRun(), locked: true }, DEF, writer)).toBe('locked');
  });

  it('locks a reader', () => {
    expect(agentMode(makeRun(), DEF, { ...writer, access: 'read' })).toBe('locked');
  });

  it('lets a writer write', () => {
    expect(agentMode(makeRun(), DEF, writer)).toBe('write');
  });

  it('locks a Pi plan agent until a person approves', () => {
    const pi = { ...writer, program: 'pi' as const, plan: true };

    expect(agentMode(makeRun(), DEF, pi)).toBe('locked');
    expect(agentMode(makeRun(), DEF, { ...pi, planApproved: true })).toBe('write');
  });

  it('leaves a Claude Code plan agent to plan mode', () => {
    expect(agentMode(makeRun(), DEF, { ...writer, plan: true })).toBe('write');
  });
});

describe('permissionModeOf', () => {
  const lead = agent(0, 'pending', { program: 'claude', plan: true });

  it('plans until a person approves', () => {
    expect(permissionModeOf(makeRun(), lead)).toBe('plan');
  });

  it('uses the chosen mode after approval', () => {
    const approved = { ...lead, planApproved: true, buildMode: 'acceptEdits' as const };

    expect(permissionModeOf(makeRun(), approved)).toBe('acceptEdits');
  });

  it('has no mode for Pi', () => {
    expect(permissionModeOf(makeRun(), { ...lead, program: 'pi' })).toBeUndefined();
  });
});

describe('reportAgent', () => {
  it('is the last agent when it ran', () => {
    const last = agent(2, 'done', { isLast: true, summary: 'Fixed' });

    expect(reportAgent(runOf([agent(0, 'done'), last]))).toBe(last);
  });

  it('falls back to the Lead when Fix skipped itself', () => {
    const lead = agent(0, 'done', { summary: 'Built' });
    const run = runOf([
      lead,
      agent(1, 'done', { summary: 'A' }),
      agent(1, 'done', { summary: 'B' }),
      agent(2, 'skipped', { isLast: true })
    ]);

    expect(reportAgent(run)).toBe(lead);
  });
});

describe('onlyWaitsForPerson', () => {
  it('is true when no agent works and the run needs a person', () => {
    const run = runOf([agent(0, 'waiting')], { state: 'needs-you' });

    expect(onlyWaitsForPerson(run)).toBe(true);
  });

  it('is false while another agent works', () => {
    const run = runOf([agent(0, 'waiting'), agent(0, 'working')], { state: 'needs-you' });

    expect(onlyWaitsForPerson(run)).toBe(false);
  });
});
