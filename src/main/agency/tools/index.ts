import type { AdmiralThreadScope, AgencySettings } from '../../../shared/agency';
import type { AgentAgencyCapability } from '../../../shared/agency-tools';
import type { AgencyService } from '../index';
import { askClient } from './ask-client';
import { jobList } from './job-list';
import { jobOpen } from './job-open';
import { jobPlan } from './job-plan';
import { jobUpdate } from './job-update';

/**
 * The agency tools of one Admiral thread, bound to its checked scope. Nothing
 * a model writes can name another repository or job: the scope is closed over.
 */
export function createAgencyCapability(
  agency: Pick<AgencyService, 'ask' | 'openJob' | 'snapshot' | 'jobs'>,
  scope: AdmiralThreadScope,
  settings: () => AgencySettings
): AgentAgencyCapability {
  const { jobId } = scope;
  return {
    askClient: async (args) => Promise.resolve(askClient(agency, scope, args)),
    jobOpen:
      scope.jobId === null
        ? async (args) =>
            Promise.resolve(
              jobOpen(agency, scope.repoId, settings().admiral.defaultBudgetUsd, args)
            )
        : null,
    jobList: async () => Promise.resolve(jobList(agency, scope.repoId)),
    jobPlan:
      jobId === null ? null : async (args) => jobPlan(agency.jobs, { ...scope, jobId }, args),
    jobUpdate:
      jobId === null ? null : async (args) => Promise.resolve(jobUpdate(agency.jobs, jobId, args))
  };
}
