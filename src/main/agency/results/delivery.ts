import type { AgencyResult } from '../../../shared/agency-jobs';
import type { DeliverableKind } from '../../../shared/agency-plan';
import type { TrustLevel } from '../../../shared/agency-projects';

/**
 * The result kinds of a job that only looked into something: text the
 * Admiral can restate on the Bridge. A job that hands back only these has
 * nothing left for the client to merge, review in place or keep running.
 */
const EXPLORATION_KINDS: readonly DeliverableKind[] = ['doc', 'review', 'report', 'copy', 'link'];

/**
 * What Fleet does once a job delivered: `merge` its PRs under Ship it, `close`
 * a job that only found things, or `tell` the Bridge and leave the job for the
 * client to accept.
 */
export type DeliveryAction = 'merge' | 'close' | 'tell';

/** The one decision on what follows a delivery, from what the job's plan listed. */
export function deliveryAction(results: AgencyResult[], trust: TrustLevel): DeliveryAction {
  const listed = results.filter((r) => r.listed);
  if (listed.length === 0) return 'tell';
  if (trust === 'ship' && listed.every((r) => r.body.kind === 'pr')) return 'merge';
  if (results.every((r) => EXPLORATION_KINDS.includes(r.kind))) return 'close';
  return 'tell';
}
