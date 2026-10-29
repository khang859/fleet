import type { AgencyResult } from '../../../shared/agency-jobs';
import type { DeliverableKind } from '../../../shared/agency-plan';

/**
 * The result kinds of a job that only looked into something: text the
 * Admiral can restate on the Bridge. A job that hands back only these has
 * nothing left for the client to merge, review in place or keep running.
 */
const EXPLORATION_KINDS: readonly DeliverableKind[] = ['doc', 'review', 'report', 'copy', 'link'];

/**
 * What Fleet does once a job delivered: `close` a job that only found things,
 * or `tell` the Bridge and leave the job for the client to merge or accept.
 */
export type DeliveryAction = 'close' | 'tell';

/** The one decision on what follows a delivery, from what the job's plan listed. */
export function deliveryAction(results: AgencyResult[]): DeliveryAction {
  if (!results.some((r) => r.listed)) return 'tell';
  if (results.every((r) => EXPLORATION_KINDS.includes(r.kind))) return 'close';
  return 'tell';
}
