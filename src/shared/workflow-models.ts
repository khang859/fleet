// The model and effort an agent runs with. Unset means the program's own default.

import type { WorkflowProgram, WorkflowStageDef } from './workflows';

/** The levels each program takes: `--effort` for Claude Code, `--thinking` for Pi. */
export const EFFORT_LEVELS: Record<WorkflowProgram, readonly string[]> = {
  claude: ['low', 'medium', 'high', 'xhigh', 'max'],
  pi: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
};

/** The Claude Code aliases that always name the latest model of a family. */
export const CLAUDE_MODELS: readonly string[] = ['fable', 'opus', 'sonnet', 'haiku'];

/**
 * A model name or ID, such as `opus`, `claude-opus-5-5[1m]` or `openai/gpt-5:high`.
 * It goes on a command line, so it cannot start with `-` or hold a space.
 */
export const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@[\]-]{0,119}$/;

export type ModelChoice = { model?: string; effort?: string };

export function isEffortOf(program: WorkflowProgram, effort: string): boolean {
  return EFFORT_LEVELS[program].includes(effort);
}

/** What is wrong with a choice for this program, or null. */
export function modelChoiceProblem(program: WorkflowProgram, choice: ModelChoice): string | null {
  if (choice.model !== undefined && !MODEL_PATTERN.test(choice.model)) {
    return `model "${choice.model}" is not a model name.`;
  }
  if (choice.effort !== undefined && !isEffortOf(program, choice.effort)) {
    return `effort must be one of ${EFFORT_LEVELS[program].join(', ')}.`;
  }
  return null;
}

/**
 * An agent moved to a program. A model name means nothing to the other program,
 * so it goes. A level stays when the other program has it.
 */
export function switchProgram<T extends ModelChoice & { program: WorkflowProgram }>(
  agent: T,
  program: WorkflowProgram
): T {
  if (agent.program === program) return agent;
  const keepEffort = agent.effort !== undefined && isEffortOf(program, agent.effort);
  return { ...agent, program, model: undefined, effort: keepEffort ? agent.effort : undefined };
}

/** The words for a choice, such as `opus · high`, or '' for the program defaults. */
export function modelChoiceText(choice: ModelChoice): string {
  return [choice.model, choice.effort].filter(Boolean).join(' · ');
}

/**
 * Each agent's model and effort as it runs, by stage. An agent with `resume` takes
 * those of the latest earlier agent with that role, unless it sets its own.
 */
export function effectiveChoices(stages: WorkflowStageDef[]): ModelChoice[][] {
  const byRole = new Map<string, ModelChoice>();
  return stages.map((stage) => {
    const choices = stage.agents.map((agent) => {
      const from = agent.resume === undefined ? undefined : byRole.get(agent.resume);
      return { model: agent.model ?? from?.model, effort: agent.effort ?? from?.effort };
    });
    stage.agents.forEach((agent, index) => byRole.set(agent.role, choices[index]));
    return choices;
  });
}

/** The models `pi --list-models` prints, as `provider/model`. */
export function parsePiModels(text: string): string[] {
  const lines = text.split('\n');
  const header = lines.findIndex((line) => /^provider\s+model\b/.test(line.trim()));
  if (header < 0) return [];
  return lines
    .slice(header + 1)
    .map((line) => line.trim().split(/\s+/))
    .filter((cols) => cols.length >= 2 && cols[0] !== '')
    .map(([provider, model]) => `${provider}/${model}`)
    .filter((model) => MODEL_PATTERN.test(model));
}
