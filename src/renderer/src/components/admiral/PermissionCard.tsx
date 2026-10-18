import { useEffect, useState } from 'react';
import { Check, X } from 'lucide-react';
import {
  permissionDisplayId,
  type AgencyPermission,
  type PermissionDecision
} from '../../../../shared/agency-permissions';
import { focusPane } from '../../lib/focus-pane';
import { PRIMARY, SECONDARY } from './JobClose';
import { useRefusable } from './use-refusable';

/** How a request that no longer waits ended, on its card. */
function endedText(p: AgencyPermission): string {
  if (p.state === 'void') return p.reason;
  const verb = p.state === 'allowed' ? 'Allowed' : 'Denied';
  switch (p.answeredBy) {
    case 'client':
      return `${verb} by you.`;
    case 'expiry':
      return 'Denied: the card expired before you answered.';
    case 'admiral':
      return `${verb} by the Admiral.`;
    case 'elsewhere':
    case null:
      return `${verb} outside the job sheet.`;
  }
}

/** `4m`, or `45s` in the last minute. */
function leftText(ms: number): string {
  const sec = Math.max(0, Math.ceil(ms / 1000));
  return sec >= 60 ? `${Math.ceil(sec / 60)}m` : `${sec}s`;
}

/** The clock, once a second while a card counts down. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

/**
 * A crew member's permission request, as the client answers it. The answer
 * the Admiral recommends comes first, marked as its pick; an unanswered card
 * is denied when it expires. A request Fleet no longer holds waits in the
 * crew pane, so Peek takes the client there. The same card in the
 * conversation and under WAITING ON YOU.
 */
export function PermissionCard({
  permission: p,
  paneId
}: {
  permission: AgencyPermission;
  /** The crew member's pane, for Peek. */
  paneId: string | null;
}): React.JSX.Element {
  const waiting = p.state === 'client';
  const now = useNow(waiting && p.expiresAt !== null);
  const open = waiting || p.state === 'in_pane';
  const title =
    p.summary === null
      ? `${p.crewLabel} asks to use ${p.tool}`
      : `${p.crewLabel} asks to ${p.summary}`;

  return (
    <section
      aria-label={`Permission ${permissionDisplayId(p.id)}`}
      className={`flex flex-col gap-1.5 rounded-md border bg-fleet-bg p-2.5 ${
        open ? 'border-amber-400/35' : 'border-fleet-border'
      }`}
    >
      <div className="flex items-baseline gap-2">
        <span className="flex-1 text-[13px] font-medium text-fleet-text">{title}</span>
        {waiting && p.expiresAt !== null && (
          <span className="shrink-0 text-[11px] text-fleet-text-subtle">
            expires in {leftText(p.expiresAt - now)}
          </span>
        )}
      </div>
      <code className="block max-h-22 overflow-y-auto rounded bg-fleet-surface-2 px-1.5 py-1 font-mono text-[11px] leading-4 break-all whitespace-pre-wrap text-fleet-text-secondary">
        {p.target}
      </code>
      {p.state === 'in_pane' ? (
        <p className="text-xs leading-relaxed text-fleet-text-muted">
          Fleet stopped holding this request, so it waits in {p.crewLabel}&apos;s pane. Answer it
          there.
        </p>
      ) : (
        p.reason !== '' && (
          <p className="text-xs leading-relaxed text-fleet-text-muted">
            {open ? p.reason : endedText(p)}
          </p>
        )
      )}
      {waiting && <CardAnswers permission={p} />}
      {p.state === 'in_pane' && paneId !== null && (
        <div className="flex pt-0.5">
          <button type="button" onClick={() => void focusPane(paneId)} className={SECONDARY}>
            Peek
          </button>
        </div>
      )}
    </section>
  );
}

/** Allow once and Deny, the Admiral's pick first, and why main refused an answer. */
function CardAnswers({ permission: p }: { permission: AgencyPermission }): React.JSX.Element {
  const answer = useRefusable(async (decision: PermissionDecision) =>
    window.fleet.agency.answerPermission({ id: p.id, decision })
  );
  const pick = p.recommend ?? 'deny';
  const order: PermissionDecision[] = pick === 'deny' ? ['deny', 'allow'] : ['allow', 'deny'];
  return (
    <>
      <div className="flex gap-1.5 pt-0.5">
        {order.map((decision) => (
          <button
            key={decision}
            type="button"
            disabled={answer.busy}
            onClick={() => void answer.run(decision)}
            className={decision === pick ? PRIMARY : SECONDARY}
          >
            {decision === 'allow' ? 'Allow once' : 'Deny'}
            {decision === pick && ' · My pick'}
          </button>
        ))}
      </div>
      {answer.refused !== null && (
        <p role="alert" className="text-xs text-red-400">
          {answer.refused}
        </p>
      )}
    </>
  );
}

/**
 * What the Admiral answered on one line, under the turn that answered it:
 * `✓ Allowed builder 1  git push origin job/7 · fits step 1`.
 */
export function PermissionLine({
  permission: p,
  decision,
  reason
}: {
  permission: AgencyPermission;
  decision: PermissionDecision;
  reason: string;
}): React.JSX.Element {
  const Icon = decision === 'allow' ? Check : X;
  return (
    <div className="flex min-w-0 items-center gap-1.5 text-xs text-fleet-text-muted">
      <Icon
        size={12}
        aria-hidden
        className={`shrink-0 ${decision === 'allow' ? 'text-green-400' : 'text-red-400'}`}
      />
      <span className="shrink-0">
        {decision === 'allow' ? 'Allowed' : 'Denied'} {p.crewLabel}
      </span>
      {/* The target keeps up to half the line, so a long reason cannot squeeze it to a few letters. */}
      <span
        className={`min-w-0 truncate font-mono text-[11px] ${reason === '' ? '' : 'max-w-1/2 shrink-0'}`}
      >
        {p.target.split('\n')[0]}
      </span>
      {reason !== '' && <span className="min-w-0 flex-1 truncate">· {reason}</span>}
    </div>
  );
}
