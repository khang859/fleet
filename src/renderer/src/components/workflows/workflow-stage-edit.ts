import {
  latestWithRole,
  type WorkflowAgentDef,
  type WorkflowDef,
  type WorkflowStageDef
} from '../../../../shared/workflows';

/** Where an agent is on the map. */
export type AgentAt = { stage: number; agent: number };

export function replaceAt<T>(list: T[], index: number, item: T): T[] {
  return list.map((current, at) => (at === index ? item : current));
}

function insertAt<T>(list: T[], index: number, item: T): T[] {
  return [...list.slice(0, index), item, ...list.slice(index)];
}

/** A file with a new map. An old file takes the stage shape from this first edit on. */
export function withStages(def: WorkflowDef, stages: WorkflowStageDef[]): WorkflowDef {
  return { ...def, agents: [], judge: undefined, stages };
}

function freeStageName(stages: WorkflowStageDef[]): string {
  const taken = new Set(stages.map((stage) => stage.name));
  let number = stages.length + 1;
  while (taken.has(`Stage ${number}`)) number += 1;
  return `Stage ${number}`;
}

export function addStage(stages: WorkflowStageDef[], at: number): WorkflowStageDef[] {
  return insertAt(stages, at, { name: freeStageName(stages), agents: [] });
}

export function removeStage(stages: WorkflowStageDef[], at: number): WorkflowStageDef[] {
  return stages.filter((_, index) => index !== at);
}

export function changeStage(
  stages: WorkflowStageDef[],
  at: number,
  change: Partial<WorkflowStageDef>
): WorkflowStageDef[] {
  return replaceAt(stages, at, { ...stages[at], ...change });
}

export function addAgent(
  stages: WorkflowStageDef[],
  at: number,
  agent: WorkflowAgentDef
): WorkflowStageDef[] {
  return changeStage(stages, at, { agents: [...stages[at].agents, agent] });
}

export function changeAgent(
  stages: WorkflowStageDef[],
  { stage, agent }: AgentAt,
  next: WorkflowAgentDef
): WorkflowStageDef[] {
  return changeStage(stages, stage, { agents: replaceAt(stages[stage].agents, agent, next) });
}

export function removeAgent(
  stages: WorkflowStageDef[],
  { stage, agent }: AgentAt
): WorkflowStageDef[] {
  const agents = stages[stage].agents.filter((_, index) => index !== agent);
  return changeStage(stages, stage, { agents });
}

export function moveAgent(
  stages: WorkflowStageDef[],
  from: AgentAt,
  stage: number
): WorkflowStageDef[] {
  const moved = stages[from.stage].agents[from.agent];
  return addAgent(removeAgent(stages, from), stage, moved);
}

/** Two agents that change code at once in one folder can undo each other's work. */
export function hasTwoWriters(agents: WorkflowAgentDef[]): boolean {
  return agents.filter((agent) => agent.access === 'write').length > 1;
}

/** The roles an agent in this stage can go on from. */
export function earlierRoles(stages: WorkflowStageDef[], stage: number): string[] {
  const roles = stages.slice(0, stage).flatMap((each) => each.agents.map((agent) => agent.role));
  return [...new Set(roles)];
}

/** The agent an agent goes on from, for its program. */
export function resumeTarget(
  stages: WorkflowStageDef[],
  stage: number,
  role: string
): WorkflowAgentDef | undefined {
  return latestWithRole(stages.slice(0, stage), role);
}
