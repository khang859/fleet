import type { PermissionOutcome, PermissionRequestPayload } from '../../../../shared/chat-permissions';

/** The pending bar's derived view: what to show now and what's queued behind it. */
export type PermissionView = {
  /** The first still-undecided request, or null when nothing needs a decision. */
  active: PermissionRequestPayload | null;
  /** Count of still-undecided requests (including the active one). */
  undecidedCount: number;
  /** How many undecided requests are queued behind the active one (>= 0). */
  more: number;
  /** The undecided requests behind the active one (for the "+N more" peek). */
  queued: PermissionRequestPayload[];
  /** Every undecided request id, in order (for "Allow all"). */
  undecidedIds: string[];
};

/**
 * Derive the pending bar's view from the raw permission queue and the set of
 * already-decided request ids. Decided requests are skipped so the bar always
 * surfaces the next thing actually awaiting the user.
 */
export function permissionView(
  requests: PermissionRequestPayload[],
  decided: Record<string, PermissionOutcome>
): PermissionView {
  const undecided = requests.filter((r) => !decided[r.requestId]);
  const [active = null, ...queued] = undecided;
  return {
    active,
    undecidedCount: undecided.length,
    more: Math.max(0, undecided.length - 1),
    queued,
    undecidedIds: undecided.map((r) => r.requestId)
  };
}
