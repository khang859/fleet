import {
  DEFAULT_AGENCY_SETTINGS,
  type AgencyJob,
  type AgencyRepoRef
} from '../../../shared/agency';
import { PlanSchema, type PlanInput } from '../../../shared/agency-plan';
import type { AgentAgencyCapability } from '../../../shared/agency-tools';
import type { AgencyService } from '../index';
import { createAgencyCapability } from '../tools';
import { REPO } from './fixture';

export type PlanHelpers = {
  /** A job in `REPO` and the Admiral tools of its thread. */
  openJob: (title?: string) => { job: AgencyJob; tools: AgentAgencyCapability };
  /** The tools of an existing job's thread, on the service as it is now. */
  toolsFor: (jobId: number) => AgentAgencyCapability;
  /** Propose with `job_plan`; the version id its row points at, and the text the model reads. */
  proposeOut: (
    tools: AgentAgencyCapability,
    plan?: PlanInput
  ) => Promise<{ id: number; text: string }>;
  propose: (tools: AgentAgencyCapability, plan?: PlanInput) => Promise<number>;
  /** Propose, then approve as the client; throws with main's reason when refused. */
  approve: (tools: AgentAgencyCapability, plan?: PlanInput) => Promise<number>;
};

/** Plan helpers over the service a test has now; `service` is read on each call. */
export function planHelpers(service: () => AgencyService, base: PlanInput): PlanHelpers {
  const settings = (): typeof DEFAULT_AGENCY_SETTINGS => ({
    ...DEFAULT_AGENCY_SETTINGS,
    enabled: true
  });
  const toolsFor = (jobId: number): AgentAgencyCapability =>
    createAgencyCapability(service(), { repoId: REPO.repoId, jobId }, settings);
  const proposeOut = async (
    tools: AgentAgencyCapability,
    plan: PlanInput = base
  ): Promise<{ id: number; text: string }> => {
    const out = await tools.jobPlan!(PlanSchema.parse(plan));
    const id = /plan#(\d+)/.exec(out.summary)?.[1];
    if (id === undefined) throw new Error(out.text);
    return { id: Number(id), text: out.text };
  };
  return {
    openJob: (title = 'Dark mode') => {
      const job = service().openJob({
        repoId: REPO.repoId,
        title,
        brief: 'Add dark mode, please',
        budgetUsd: null
      });
      return { job, tools: toolsFor(job.id) };
    },
    toolsFor,
    proposeOut,
    propose: async (tools, plan) => (await proposeOut(tools, plan)).id,
    approve: async (tools, plan) => {
      const { id } = await proposeOut(tools, plan);
      const result = await service().jobs.decide({ planVersionId: id, action: 'approve' });
      if (!result.ok) throw new Error(result.reason);
      return id;
    }
  };
}

/**
 * A job in `repo` with a plan of `steps` approved by the client, through the
 * Admiral's tools, so each member's base is pinned the way a real job's is.
 */
export async function approvedJobIn(
  service: AgencyService,
  repo: AgencyRepoRef,
  steps: PlanInput['steps'][number] | PlanInput['steps']
): Promise<{ jobId: number; tools: AgentAgencyCapability }> {
  service.ensureLobby(repo);
  const job = service.openJob({
    repoId: repo.repoId,
    title: 'Job',
    brief: 'Do it',
    budgetUsd: null
  });
  const tools = createAgencyCapability(service, { repoId: repo.repoId, jobId: job.id }, () => ({
    ...DEFAULT_AGENCY_SETTINGS,
    enabled: true
  }));
  const plan = PlanSchema.parse({
    playbook: 'feature',
    summary: 'Do it.',
    steps: Array.isArray(steps) ? steps : [steps],
    budget: { usd: 5 }
  });
  const out = await tools.jobPlan!(plan);
  const id = Number(/plan#(\d+)/.exec(out.summary)?.[1]);
  const decided = await service.jobs.decide({ planVersionId: id, action: 'approve' });
  if (!decided.ok) throw new Error(`${decided.reason} ${out.text}`);
  return { jobId: job.id, tools };
}

/** The project at `root`, as the Admiral's tools name it. */
export async function repoAt(service: AgencyService, root: string): Promise<AgencyRepoRef> {
  const res = await service.resolveRepo(root);
  if (!res.ok) throw new Error(`${root} is not a project`);
  return { repoId: res.repoId, root: res.root, name: res.name };
}
