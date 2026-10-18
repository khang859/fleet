import type { GitRun } from '../repo-identity';
import type { AgencyStore, AgencyTouched } from '../store/agency-store';
import { LOST_AT_RESTART, type CrewRecord } from '../store/crew-store';
import type { CrewControl } from './index';

export type ReconcileDeps = { store: AgencyStore; crew: CrewControl; git: GitRun };

/**
 * At launch: a running job whose crew panes are gone lost them to the
 * restart. Its crew end, their running steps become `interrupted`, the job is
 * interrupted with a Resume or Cancel card, and the Admiral gets a line on
 * where each step's worktree was left. Nothing restarts until the client
 * picks Resume.
 */
export async function reconcileAtStartup(deps: ReconcileDeps): Promise<AgencyTouched[]> {
  const { store } = deps;
  const live = deps.crew.livePanes();
  const touched: AgencyTouched[] = [];
  for (const job of store.jobsIn(['running', 'waiting'])) {
    const lost = store.crew.live(job.id).filter((c) => c.paneId === null || !live.has(c.paneId));
    if (lost.length === 0) continue;
    const where = await Promise.all(lost.map(async (c) => worktreeLine(deps, c)));
    store.tx(() => {
      const steps = new Map(store.plans.steps(job.id).map((s) => [s.id, s.status]));
      for (const crew of lost) {
        store.crew.end(crew.id, LOST_AT_RESTART);
        if (steps.get(crew.stepId) !== 'running') continue;
        steps.set(crew.stepId, 'interrupted');
        store.plans.setStepStatus(job.id, crew.stepId, 'interrupted');
        store.plans.log({
          jobId: job.id,
          kind: 'step',
          stepId: crew.stepId,
          text: `Step ${crew.stepId} interrupted: Fleet restarted`
        });
      }
      store.applyJobEvent(job.id, { type: 'interrupt' }, 'Fleet restarted');
      store.askQuestion({
        repoId: job.repoId,
        jobId: job.id,
        kind: 'resume',
        question: 'Fleet restarted while the crew were working',
        context: `${lost.length === 1 ? '1 crew member' : `${lost.length} crew members`} stopped. Nothing starts again until you pick.`,
        options: [
          { label: 'Resume', detail: 'restart each crew member where it was' },
          { label: 'Cancel', detail: 'close the job and clean up' }
        ],
        recommended: 0
      });
      store.enqueueWakeup({
        repoId: job.repoId,
        jobId: job.id,
        kind: 'event',
        payload: {
          line: 'Fleet restarted and the crew stopped. The client picks Resume or Cancel.',
          body: where.join('\n')
        }
      });
    });
    touched.push({ repoId: job.repoId, jobId: job.id });
  }
  return touched;
}

/** Where a lost crew member's worktree was left, read with read-only git. */
async function worktreeLine(deps: ReconcileDeps, crew: CrewRecord): Promise<string> {
  const who = `${crew.label} (${crew.stepId})`;
  const root =
    crew.workspaceId === null ? null : deps.store.resources.workspaceRoot(crew.workspaceId);
  if (root === null) return `${who}: no worktree.`;
  const [status, last] = await Promise.all([
    deps.git(['--no-optional-locks', 'status', '--porcelain'], root),
    deps.git(['log', '-1', '--format=%h %s'], root)
  ]);
  if (status === null) return `${who}: git could not read ${root}.`;
  const changes = status.split('\n').filter((l) => l !== '').length;
  return `${who}: ${changes} uncommitted ${changes === 1 ? 'change' : 'changes'}, last commit ${last ?? 'none'}.`;
}
