import { DEFAULT_AGENCY_SETTINGS, type AgencyJob } from '../../../shared/agency';
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
