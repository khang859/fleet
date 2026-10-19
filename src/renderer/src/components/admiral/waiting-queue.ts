import type { AgencyJob, AgencyQuestion, AgencySnapshot } from '../../../../shared/agency';
import type {
  AgencyCrewMember,
  AgencyJobDetail,
  AgencyPlanVersion
} from '../../../../shared/agency-jobs';
import type { AgencyPermission } from '../../../../shared/agency-permissions';
import type { SettingsCard } from '../../../../shared/agency-settings';

type Base = {
  /** Stable across reloads: `perm:7`, `plan:12`, `q:35`, `settings:4`, `delivered:24`, `crew:9`. */
  key: string;
  /** The job it belongs to; null for a lobby question or settings card. */
  jobId: number | null;
  /** When it came to the client. */
  since: number;
  /** When Fleet answers it if the client does not; null when it waits for good. */
  expiresAt: number | null;
};

/**
 * One thing that waits on the client. `loading` stands in, from the
 * snapshot's hint alone, for a plan, permission or crew member whose job
 * detail has not arrived, so the count does not jump when it does.
 */
export type WaitingItem = Base &
  (
    | { kind: 'permission'; permission: AgencyPermission; detail: AgencyJobDetail }
    | { kind: 'plan'; version: AgencyPlanVersion; detail: AgencyJobDetail }
    | { kind: 'question'; question: AgencyQuestion }
    | { kind: 'settings'; card: SettingsCard }
    | { kind: 'delivered'; job: AgencyJob; detail: AgencyJobDetail | undefined }
    | { kind: 'crew'; member: AgencyCrewMember }
    | { kind: 'loading'; job: AgencyJob; what: 'plan' | 'permission' | 'crew' }
  );

export type WaitingKind = WaitingItem['kind'];

/** Whether a job's waiting items need its detail: plans, permissions and crew are only there. */
export function needsDetail(job: AgencyJob): boolean {
  return (
    job.pendingPlan !== null ||
    job.permissionsWaiting.length > 0 ||
    job.crewNeedingYou > 0 ||
    job.state === 'delivered'
  );
}

/**
 * Everything that waits on the client, in the order a job sheet shows it:
 * delivered, permissions, the plan, questions, settings, crew. `scope` is one
 * job, the lobby (null), or the whole project (undefined: every open job and
 * the lobby). Items the client decided from the Bridge and Fleet still holds
 * are left out: the queue shows them as their own line.
 */
export function waitingItems(
  snapshot: AgencySnapshot | undefined,
  details: Partial<Record<number, AgencyJobDetail>>,
  scope?: number | null
): WaitingItem[] {
  if (snapshot === undefined) return [];
  const held = new Set(snapshot.held.map((h) => h.key));
  const inScope = (jobId: number | null): boolean => scope === undefined || jobId === scope;
  const items: WaitingItem[] = [];
  const lobby = inScope(null) ? lobbyItems(snapshot, null) : [];
  for (const job of snapshot.jobs) {
    if (inScope(job.id)) items.push(...jobItems(snapshot, job, details[job.id]));
  }
  return [...items, ...lobby].filter((item) => !held.has(item.key));
}

/** The items of one kind, typed as that kind. */
export function itemsOf<K extends WaitingKind>(
  items: readonly WaitingItem[],
  kind: K
): Array<Extract<WaitingItem, { kind: K }>> {
  return items.filter((i): i is Extract<WaitingItem, { kind: K }> => i.kind === kind);
}

/** The queue's order: what expires first, soonest first, then the rest, oldest first. */
export function queueOrder(items: readonly WaitingItem[]): WaitingItem[] {
  return [...items].sort((a, b) => {
    if (a.expiresAt !== null || b.expiresAt !== null) {
      if (a.expiresAt === null) return 1;
      if (b.expiresAt === null) return -1;
      if (a.expiresAt !== b.expiresAt) return a.expiresAt - b.expiresAt;
    }
    return a.since - b.since;
  });
}

function jobItems(
  snapshot: AgencySnapshot,
  job: AgencyJob,
  detail: AgencyJobDetail | undefined
): WaitingItem[] {
  const items: WaitingItem[] = [];
  if (job.state === 'delivered') {
    items.push({
      key: `delivered:${job.id}`,
      jobId: job.id,
      since: job.updatedAt,
      expiresAt: null,
      kind: 'delivered',
      job,
      detail
    });
  }
  const loading = loadingItems(job);
  return [
    ...items,
    ...(detail === undefined
      ? [...loading.permissions, ...loading.plan]
      : detailItems(job, detail)),
    ...lobbyItems(snapshot, job.id),
    ...(detail === undefined ? loading.crew : crewItems(job, detail))
  ];
}

/** The permissions and plan a loaded detail shows waiting on the client. */
function detailItems(job: AgencyJob, detail: AgencyJobDetail): WaitingItem[] {
  const items: WaitingItem[] = detail.permissions
    .filter((p) => p.state === 'client' || p.state === 'in_pane')
    .map((permission) => ({
      key: `perm:${permission.id}`,
      jobId: job.id,
      since: permission.askedAt ?? permission.createdAt,
      expiresAt: permission.state === 'client' ? permission.expiresAt : null,
      kind: 'permission',
      permission,
      detail
    }));
  const version = detail.versions.find((v) => v.status === 'proposed');
  if (version !== undefined) {
    items.push({
      key: `plan:${version.id}`,
      jobId: job.id,
      since: version.proposedAt,
      expiresAt: null,
      kind: 'plan',
      version,
      detail
    });
  }
  return items;
}

function crewItems(job: AgencyJob, detail: AgencyJobDetail): WaitingItem[] {
  return detail.crew
    .filter((c) => c.flag === 'needs-you')
    .map((member) => ({
      key: `crew:${member.id}`,
      jobId: job.id,
      since: member.startedAt,
      expiresAt: null,
      kind: 'crew',
      member
    }));
}

/** One row per thing the snapshot says waits, until the job's detail arrives. */
function loadingItems(job: AgencyJob): Record<'permissions' | 'plan' | 'crew', WaitingItem[]> {
  const row = (
    key: string,
    what: 'plan' | 'permission' | 'crew'
  ): Extract<WaitingItem, { kind: 'loading' }> => ({
    key,
    jobId: job.id,
    since: job.updatedAt,
    expiresAt: null,
    kind: 'loading',
    job,
    what
  });
  return {
    permissions: job.permissionsWaiting.map((id) => row(`perm:${id}`, 'permission')),
    plan: job.pendingPlan === null ? [] : [row(`plan:${job.pendingPlan.id}`, 'plan')],
    crew: Array.from({ length: job.crewNeedingYou }, (_, i) =>
      row(`crew:job${job.id}-${i}`, 'crew')
    )
  };
}

/** Open questions and settings cards with a change still to decide, of one job or the lobby. */
function lobbyItems(snapshot: AgencySnapshot, jobId: number | null): WaitingItem[] {
  const questions = snapshot.questions
    .filter((q) => q.status === 'open' && q.jobId === jobId)
    .map(
      (question): WaitingItem => ({
        key: `q:${question.id}`,
        jobId,
        since: question.createdAt,
        expiresAt: null,
        kind: 'question',
        question
      })
    );
  const settings = snapshot.settingsCards
    .filter((c) => c.jobId === jobId && c.changes.some((x) => x.status === 'pending'))
    .map(
      (card): WaitingItem => ({
        key: `settings:${card.id}`,
        jobId,
        since: card.at,
        expiresAt: null,
        kind: 'settings',
        card
      })
    );
  return [...questions, ...settings];
}
