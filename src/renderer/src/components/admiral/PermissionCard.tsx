import { useEffect, useState } from 'react';
import { Check, X } from 'lucide-react';
import type { AgencyResult } from '../../../../shared/agency-jobs';
import {
  PERMISSION_REASON_MAX_CHARS,
  permissionDisplayId,
  type AgencyPermission,
  type PermissionAnswerRequest,
  type PermissionDecision
} from '../../../../shared/agency-permissions';
import { useNow } from '../../hooks/use-now';
import { focusPane } from '../../lib/focus-pane';
import { PRIMARY, Refused, SECONDARY } from './JobClose';
import { ReaderFrame, ReaderSection } from './ReaderFrame';
import { leftText } from './job-view';
import { useRefusable, type RefusableAction } from './use-refusable';

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

/**
 * A crew member's permission request, as the client answers it. The answer
 * the Admiral recommends comes first, marked as its pick; an unanswered card
 * is denied when it expires. A request Fleet no longer holds waits in the
 * crew pane, so Peek takes the client there. The same card in the
 * conversation, under WAITING ON YOU and in the Bridge queue.
 */
export function PermissionCard({
  permission: p,
  paneId,
  head,
  layout = 'card',
  results = []
}: {
  permission: AgencyPermission;
  /** The crew member's pane, for Peek. */
  paneId: string | null;
  /** A first row, as the Bridge queue names the job and kind. */
  head?: React.ReactNode;
  /** `reader`: in full in the Bridge's main column, with the actions in a footer. */
  layout?: 'card' | 'reader';
  /** The job's results, for the checks of its pull requests in the reader. */
  results?: AgencyResult[];
}): React.JSX.Element {
  if (layout === 'reader') {
    return <PermissionReader permission={p} paneId={paneId} head={head} results={results} />;
  }
  return <CompactPermission permission={p} paneId={paneId} head={head} />;
}

function title(p: AgencyPermission): string {
  return p.summary === null
    ? `${p.crewLabel} asks to use ${p.tool}`
    : `${p.crewLabel} asks to ${p.summary}`;
}

function CompactPermission({
  permission: p,
  paneId,
  head
}: {
  permission: AgencyPermission;
  paneId: string | null;
  head: React.ReactNode;
}): React.JSX.Element {
  const waiting = p.state === 'client';
  const now = useNow(waiting && p.expiresAt !== null);
  const open = waiting || p.state === 'in_pane';

  return (
    <section
      aria-label={`Permission ${permissionDisplayId(p.id)}`}
      className={`flex flex-col gap-1.5 rounded-md border bg-fleet-bg p-2.5 ${
        open ? 'border-amber-400/35' : 'border-fleet-border'
      }`}
    >
      {head}
      <div className="flex items-baseline gap-2">
        <span className="flex-1 text-[13px] font-medium text-fleet-text">{title(p)}</span>
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

/** Answer a request, and keep main's reason when it refuses. */
function usePermissionAnswer(
  p: AgencyPermission
): RefusableAction<Omit<PermissionAnswerRequest, 'id'>> {
  return useRefusable(async (req: Omit<PermissionAnswerRequest, 'id'>) =>
    window.fleet.agency.answerPermission({ id: p.id, ...req })
  );
}

/** Allow once and Deny, the Admiral's pick first. */
function AnswerButtons({
  permission: p,
  answer
}: {
  permission: AgencyPermission;
  answer: RefusableAction<Omit<PermissionAnswerRequest, 'id'>>;
}): React.JSX.Element {
  const pick = p.recommend ?? 'deny';
  const order: PermissionDecision[] = pick === 'deny' ? ['deny', 'allow'] : ['allow', 'deny'];
  return (
    <>
      {order.map((decision) => (
        <button
          key={decision}
          type="button"
          disabled={answer.busy}
          onClick={() => void answer.run({ decision })}
          className={decision === pick ? PRIMARY : SECONDARY}
        >
          {decision === 'allow' ? 'Allow once' : 'Deny'}
          {decision === pick && ' · My pick'}
        </button>
      ))}
    </>
  );
}

function CardAnswers({ permission: p }: { permission: AgencyPermission }): React.JSX.Element {
  const answer = usePermissionAnswer(p);
  return (
    <>
      <div className="flex gap-1.5 pt-0.5">
        <AnswerButtons permission={p} answer={answer} />
      </div>
      <Refused reason={answer.refused} />
    </>
  );
}

/** How often the permission reader reads the crew pane again. */
const CREW_SCREEN_POLL_MS = 2000;

/** The last lines of a crew member's pane, read again every 2 seconds; undefined until first read. */
function useCrewScreen(crewId: number): string | null | undefined {
  const [screen, setScreen] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    const read = (): void => {
      void window.fleet.agency
        .crewScreen(crewId)
        .catch(() => null)
        .then((text) => {
          if (live) setScreen(text);
        });
    };
    read();
    const timer = setInterval(read, CREW_SCREEN_POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [crewId]);
  return screen;
}

/**
 * A request in full: the whole target, the time left, why it came to the
 * client, the checks of the job's pull requests, and what the crew member's
 * pane shows now. The pane text is the crew's, so it shows as plain text.
 */
function PermissionReader({
  permission: p,
  paneId,
  head,
  results
}: {
  permission: AgencyPermission;
  paneId: string | null;
  head: React.ReactNode;
  results: AgencyResult[];
}): React.JSX.Element {
  const waiting = p.state === 'client';
  const now = useNow(waiting && p.expiresAt !== null);
  const screen = useCrewScreen(p.crewId);
  const prs = results.flatMap((r) => (r.body.kind === 'pr' ? [r.body.pr] : []));
  return (
    <ReaderFrame head={head} footer={waiting ? <ReaderAnswers permission={p} /> : undefined}>
      <div className="flex flex-col gap-1">
        <h2 className="text-base font-semibold text-fleet-text">{title(p)}</h2>
        {waiting && p.expiresAt !== null && (
          <p className="text-xs text-fleet-text-muted">
            Denied in {leftText(p.expiresAt - now)} if you do not answer.
          </p>
        )}
      </div>
      <ReaderSection label={p.tool}>
        <code className="block rounded-md bg-fleet-surface-2 px-2.5 py-2 font-mono text-xs leading-5 break-all whitespace-pre-wrap text-fleet-text">
          {p.target}
        </code>
      </ReaderSection>
      {p.state === 'in_pane' ? (
        <p className="text-[13px] leading-relaxed text-fleet-text-muted">
          Fleet stopped holding this request, so it waits in {p.crewLabel}&apos;s pane. Answer it
          there.
        </p>
      ) : (
        <ReaderSection label="Why it came to you">
          <p className="text-[13px] leading-relaxed text-fleet-text-secondary">{p.reason}</p>
          <p className="text-xs text-fleet-text-muted">
            The Admiral would {p.recommend === 'allow' ? 'allow' : 'deny'} it.
          </p>
        </ReaderSection>
      )}
      {prs.length > 0 && (
        <ReaderSection label="Checks on the job's pull requests">
          <ul className="flex flex-col gap-1 text-xs">
            {prs.map((pr) => (
              <li key={pr.number} className="flex items-baseline gap-2">
                <span className="font-mono text-fleet-text-secondary">#{pr.number}</span>
                <span
                  className="min-w-0 flex-1 truncate text-fleet-text-secondary"
                  title={pr.title}
                >
                  {pr.title}
                </span>
                <span className="shrink-0 text-fleet-text-muted tabular-nums">
                  {pr.checks.passed} passed · {pr.checks.failed} failed · {pr.checks.pending}{' '}
                  pending
                </span>
              </li>
            ))}
          </ul>
        </ReaderSection>
      )}
      <ReaderSection label={`What ${p.crewLabel}'s pane shows`}>
        {screen === undefined ? (
          <p className="text-xs text-fleet-text-subtle">Reading the pane…</p>
        ) : screen === null ? (
          <p className="text-xs text-fleet-text-subtle">
            The pane is gone, or Fleet cannot read it.
          </p>
        ) : (
          <pre className="overflow-x-auto rounded-md bg-fleet-surface-2 px-2.5 py-2 font-mono text-[11px] leading-4 whitespace-pre text-fleet-text-secondary">
            {screen}
          </pre>
        )}
        {paneId !== null && (
          <button
            type="button"
            onClick={() => void focusPane(paneId)}
            className={`${SECONDARY} w-fit`}
          >
            Peek at the pane
          </button>
        )}
      </ReaderSection>
    </ReaderFrame>
  );
}

/** The reader's footer: Allow once and Deny, or Deny with a reason the crew member gets. */
function ReaderAnswers({ permission: p }: { permission: AgencyPermission }): React.JSX.Element {
  const answer = usePermissionAnswer(p);
  const [denying, setDenying] = useState(false);
  const [reason, setReason] = useState('');
  const typed = reason.trim();
  return (
    <>
      {denying ? (
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (typed !== '') void answer.run({ decision: 'deny', reason: typed });
          }}
        >
          <textarea
            value={reason}
            autoFocus
            rows={2}
            maxLength={PERMISSION_REASON_MAX_CHARS}
            onChange={(e) => setReason(e.target.value)}
            placeholder={`What should ${p.crewLabel} do instead?`}
            aria-label="Why you deny it"
            className="resize-none rounded-md border border-fleet-border bg-fleet-bg px-2 py-1.5 text-xs text-fleet-text outline-none placeholder:text-fleet-text-subtle focus:border-fleet-border-strong"
          />
          <div className="flex justify-end gap-1.5">
            <button type="button" onClick={() => setDenying(false)} className={SECONDARY}>
              Cancel
            </button>
            <button type="submit" disabled={answer.busy || typed === ''} className={PRIMARY}>
              Deny
            </button>
          </div>
        </form>
      ) : (
        <div className="flex flex-wrap items-center gap-1.5">
          <AnswerButtons permission={p} answer={answer} />
          <button
            type="button"
            disabled={answer.busy}
            onClick={() => setDenying(true)}
            className={SECONDARY}
          >
            Deny and say why
          </button>
        </div>
      )}
      <Refused reason={answer.refused} />
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
