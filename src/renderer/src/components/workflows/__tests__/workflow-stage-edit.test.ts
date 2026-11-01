import { describe, expect, it } from 'vitest';
import type { WorkflowAgentDef, WorkflowStageDef } from '../../../../../shared/workflows';
import {
  addAgent,
  addStage,
  earlierRoles,
  hasTwoWriters,
  moveAgent,
  removeStage,
  resumeTarget,
  withStages
} from '../workflow-stage-edit';

function agent(role: string, access: WorkflowAgentDef['access'] = 'read'): WorkflowAgentDef {
  return { role, program: 'pi', prompt: 'x', access };
}

const STAGES: WorkflowStageDef[] = [
  { name: 'One', agents: [agent('A', 'write')] },
  { name: 'Two', agents: [agent('B'), agent('C')] }
];

describe('stage edits', () => {
  it('adds a stage with a free name at the place asked', () => {
    const next = addStage(STAGES, 1);

    expect(next.map((stage) => stage.name)).toEqual(['One', 'Stage 3', 'Two']);
  });

  it('removes a stage', () => {
    expect(removeStage(STAGES, 0).map((stage) => stage.name)).toEqual(['Two']);
  });

  it('adds an agent at the end of a stage', () => {
    expect(addAgent(STAGES, 0, agent('D'))[0].agents.map((each) => each.role)).toEqual(['A', 'D']);
  });

  it('moves an agent to another stage', () => {
    const next = moveAgent(STAGES, { stage: 1, agent: 0 }, 0);

    expect(next[0].agents.map((each) => each.role)).toEqual(['A', 'B']);
    expect(next[1].agents.map((each) => each.role)).toEqual(['C']);
  });

  it('sees two writers', () => {
    expect(hasTwoWriters([agent('A', 'write'), agent('B', 'write')])).toBe(true);
    expect(hasTwoWriters([agent('A', 'write'), agent('B')])).toBe(false);
  });

  it('offers only earlier roles', () => {
    expect(earlierRoles(STAGES, 1)).toEqual(['A']);
    expect(earlierRoles(STAGES, 0)).toEqual([]);
  });

  it('finds the agent to go on from', () => {
    expect(resumeTarget(STAGES, 2, 'B')?.role).toBe('B');
  });

  it('leaves the old shape on the first map edit', () => {
    const old = {
      name: 'Old',
      shared: '',
      board: true,
      workspace: 'current' as const,
      inputs: [],
      agents: [agent('A')],
      judge: agent('J')
    };

    expect(withStages(old, STAGES)).toMatchObject({ agents: [], judge: undefined, stages: STAGES });
  });
});
