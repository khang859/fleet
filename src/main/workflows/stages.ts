import {
  agentsInStage,
  stageOf,
  stagesOf,
  type PlanBuildMode,
  type PlanVersion,
  type RunAgent,
  type WorkflowDef,
  type WorkflowRun,
  type WorkflowStageDef
} from '../../shared/workflows';
import type { AgentMode } from './agent-command';

const OVER_STATES = new Set<RunAgent['state']>(['done', 'skipped']);

export { agentsInStage as agentsIn, stageOf };

const agentsIn = agentsInStage;

function isOver(agents: RunAgent[]): boolean {
  return agents.every((agent) => OVER_STATES.has(agent.state));
}

/** Failed, and Fleet will not try it again by itself. */
function isLost(agent: RunAgent): boolean {
  return agent.state === 'skipped' || (agent.state === 'failed' && agent.autoRetried);
}

/** The agent that writes the report: a stage file's only agent in its last stage. */
export function runsLast(def: WorkflowDef, stageIndex: number): boolean {
  const stages = stagesOf(def);
  const isFinal = stageIndex === stages.length - 1;
  if (!def.stages) return def.judge !== undefined && isFinal;
  return isFinal && stages[stageIndex].agents.length === 1;
}

/** A stage with no agent that did the work, which the file does not allow to be skipped. */
function isDeadEnd(run: WorkflowRun, stage: WorkflowStageDef, index: number): boolean {
  if (stage.only_with_findings) return false;
  const others = agentsIn(run, index).filter((agent) => !agent.isLast);
  return others.length > 0 && others.every(isLost);
}

/** Every agent of a stage failed or was skipped, so the later stages cannot go on. */
export function noWayOn(run: WorkflowRun, stages: WorkflowStageDef[]): boolean {
  return stages.some((stage, index) => isDeadEnd(run, stage, index));
}

/** The next stage to start, or null when a stage still runs or none is left. */
export function stageToStart(run: WorkflowRun, stages: WorkflowStageDef[]): number | null {
  for (const [index] of stages.entries()) {
    const agents = agentsIn(run, index);
    if (agents.some((agent) => agent.state === 'pending')) return index;
    if (!isOver(agents)) return null;
  }
  return null;
}

/** The first stage with an agent that is not over. */
export function currentStage(run: WorkflowRun, stages: WorkflowStageDef[]): number | null {
  const index = stages.findIndex((_, at) => !isOver(agentsIn(run, at)));
  return index < 0 ? null : index;
}

export function hasOpenFindings(run: WorkflowRun): boolean {
  return run.board.some((item) => item.mergedInto === undefined);
}

/** A stage that skips itself: it runs only with findings, and the board has none. */
export function skipsItself(run: WorkflowRun, stage: WorkflowStageDef): boolean {
  return stage.only_with_findings === true && !hasOpenFindings(run);
}

/** The agent's flags. The run lock wins over all else. */
export function agentMode(run: WorkflowRun, def: WorkflowDef, agent: RunAgent): AgentMode {
  if (run.locked) return 'locked';
  if (!def.stages) return run.teamPr ? 'team-pr' : 'normal';
  if (agent.access !== 'write') return 'locked';
  // Pi has no plan mode: the write tools do not exist in it until a person approves.
  if (agent.plan && !agent.planApproved && agent.program === 'pi') return 'locked';
  return run.teamPr ? 'team-pr' : 'write';
}

/** The Claude Code mode to start an agent in. */
export function permissionModeOf(
  run: WorkflowRun,
  agent: RunAgent
): 'plan' | PlanBuildMode | undefined {
  if (agent.program !== 'claude' || run.locked) return undefined;
  return agent.plan && !agent.planApproved ? 'plan' : agent.buildMode;
}

/**
 * The agent whose summary is the report. When its stage skips itself, as a Fix
 * stage with no findings does, the last stage of one agent speaks for the run.
 */
export function reportAgent(run: WorkflowRun): RunAgent | undefined {
  const last = run.agents.find((agent) => agent.isLast);
  if (!last?.stageSkipped) return last;
  const isOnlyOne = (agent: RunAgent): boolean => agentsIn(run, stageOf(agent)).length === 1;
  return run.agents.findLast((agent) => agent.summary !== null && isOnlyOne(agent));
}

/** The approved plan for agents that come after it. */
export function latestPlan(run: WorkflowRun): PlanVersion | undefined {
  const approved = run.agents.filter((agent) => agent.planApproved);
  return approved.flatMap((agent) => agent.plans ?? []).at(-1);
}

/** Whether nothing moves until a person acts, so the clock must not count. */
export function onlyWaitsForPerson(run: WorkflowRun): boolean {
  const moving = (agent: RunAgent): boolean =>
    agent.state === 'working' || agent.state === 'starting';
  return run.state === 'needs-you' && !run.agents.some(moving);
}
