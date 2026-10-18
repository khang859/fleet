import type { AgencySettings } from '../../../shared/agency';
import { ADMIRAL_SYSTEM_PROMPT, ADMIRAL_TOOLS } from '../../../shared/agency-prompt';
import type { AgentAgencyCapability } from '../../../shared/agency-tools';
import { renderProjectInstructions } from '../../../shared/agent-project-instructions';
import { toolSpecsFor, type ToolSpec } from '../../../shared/agent-tools';
import { buildSystemPrompt, type AgentSendRequest } from '../../../shared/agent-types';
import type { AgentFleetCapability } from '../../../shared/fleet-tools';
import { readEnvironment } from '../../agent/environment';
import { createFleetCapability, type FleetDeps } from '../../agent/fleet/capability';
import { loadProjectInstructions } from '../../agent/project-instructions';
import type { Redactor } from '../../redactor';
import type { AgencyService } from '../index';
import { createAgencyCapability } from '../tools';
import { scopeFleetToCrew } from './crew-fleet';
import { redactOutputs } from './redact-capability';
import { crewNote } from './crew-note';
import { admiralSnapshotNote } from './snapshot-note';

/** What the agent engine needs to run Admiral turns. */
export type AdmiralDeps = {
  agency: Pick<
    AgencyService,
    | 'threadScope'
    | 'ask'
    | 'openJob'
    | 'snapshot'
    | 'crewPanes'
    | 'crewScreen'
    | 'crew'
    | 'permissions'
    | 'store'
    | 'preferencesForNote'
    | 'jobs'
    | 'results'
    | 'proposeClientFile'
    | 'settings'
    | 'crewCatalog'
    | 'crewSkills'
    | 'redactor'
    | 'spend'
  >;
  settings: () => AgencySettings;
};

/** Everything that makes a turn an Admiral's, decided before its first round. */
export type AdmiralTurnPlan = {
  systemPrompt: string;
  timeZone: string;
  tools: ToolSpec[];
  /** The only tool names the turn may run, whatever the model asks for. */
  allowedTools: ReadonlySet<string>;
  agency: AgentAgencyCapability;
  fleet: AgentFleetCapability | null;
  /** Fleet's records for this conversation, read fresh for each round. */
  note: () => string;
  instructions: { filename: string; tokens: number } | null;
};

/** The Admiral's model: its own setting, or the Agent's coding model when that is empty. */
export function admiralModel(
  admiral: AdmiralDeps | null,
  codingModel: string | null
): string | null {
  const chosen = admiral?.settings().admiral.model ?? '';
  return chosen === '' ? codingModel : chosen;
}

/**
 * Plan one Admiral turn: check the thread is what it says it is, then build
 * its prompt, its allow-listed tools and the capabilities behind them. The
 * Admiral gets no schedule, task list, skills, memory, subagents, MCP or
 * image tool, and its fleet tools see only its job's crew.
 */
export async function planAdmiralTurn(input: {
  req: AgentSendRequest;
  admiral: AdmiralDeps | null;
  fleet: FleetDeps | null;
  model: string;
  webFetch: boolean;
  /** The working folder as the prompt describes it. */
  promptCwd: string;
}): Promise<AdmiralTurnPlan> {
  const { req, admiral } = input;
  if (admiral === null) throw new Error('The Admiral is not available in this build of Fleet.');
  if (!admiral.settings().enabled) {
    throw new Error('The Admiral is turned off. Turn it on in Settings > Agency > Admiral.');
  }
  if (req.admiral === undefined) {
    throw new Error('An Admiral turn has to say which repository and job it is for.');
  }
  const scope = admiral.agency.threadScope({ ...req.admiral, threadId: req.threadId });
  // What crew wrote reaches the Admiral only through these outputs.
  const redactor = async (): Promise<Redactor> => admiral.agency.redactor(scope.repoId);
  const agency = redactOutputs(
    createAgencyCapability(admiral.agency, scope, admiral.settings),
    redactor
  );
  const fleet =
    input.fleet === null
      ? null
      : redactOutputs(
          createFleetCapability(
            scopeFleetToCrew(
              input.fleet,
              () => admiral.agency.crewPanes(scope.jobId),
              async (paneId) => admiral.agency.crewScreen(scope.jobId, paneId)
            ),
            req.threadId,
            'admiral',
            req.cwd
          ),
          redactor
        );
  const instructions = await loadProjectInstructions(req.cwd);
  const [catalog, skills] = await Promise.all([
    admiral.agency.crewCatalog(scope.repoId),
    admiral.agency.crewSkills(scope.repoId)
  ]);
  const crew = crewNote(catalog, skills);
  const env = await readEnvironment(req.cwd, input.model);
  const tools = toolSpecsFor({
    image: null,
    webFetch: input.webFetch,
    mcp: [],
    task: null,
    skill: null,
    memory: null,
    fleet,
    agency,
    only: ADMIRAL_TOOLS
  });
  return {
    systemPrompt: buildSystemPrompt(input.promptCwd, ADMIRAL_SYSTEM_PROMPT, {
      env,
      image: false,
      webFetch: input.webFetch,
      todo: false,
      projectInstructions:
        instructions === null
          ? null
          : renderProjectInstructions(instructions.filename, instructions.text)
    }),
    timeZone: env.timeZone,
    tools,
    allowedTools: new Set<string>(ADMIRAL_TOOLS),
    agency,
    fleet,
    note: () =>
      [
        admiralSnapshotNote(
          admiral.agency.store,
          scope,
          admiral.agency.preferencesForNote(scope.repoId)
        ),
        crew
      ].join('\n\n'),
    instructions:
      instructions === null
        ? null
        : { filename: instructions.filename, tokens: instructions.tokens }
  };
}
