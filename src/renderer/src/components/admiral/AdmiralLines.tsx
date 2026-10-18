import { useState } from 'react';
import { ArrowRight, BellRing, Briefcase } from 'lucide-react';
import type { AgencyJobDetail } from '../../../../shared/agency-jobs';
import type { AgentToolCall } from '../../../../shared/agent-tools';
import type { AgentMessage } from '../../../../shared/agent-types';
import { messageText } from '../../../../shared/agent-types';
import { unfence } from '../../../../shared/fleet-tools';
import {
  detailHolding,
  findQuestion,
  useAgencyStore,
  useJobDetail
} from '../../store/agency-store';
import { openSettings } from '../../store/settings-nav-store';
import { AgentToolRow } from '../agent/AgentToolRow';
import { useAdmiralThread } from './admiral-context';
import { PermissionCard, PermissionLine } from './PermissionCard';
import { PlanCard } from './PlanCard';
import { QuestionCard } from './QuestionCard';
import { ResultCard } from './ResultCard';
import { SettingsCardView } from './SettingsCard';
import {
  answeredPermissionId,
  askedQuestionId,
  deliveredResultId,
  jobLink,
  proposedPlanId,
  settingsCardId
} from './job-view';

/**
 * The lines an Admiral transcript has that an Agent one does not: what woke
 * the Admiral, a job opened from the lobby, and a question or plan card where
 * the Admiral put one up, and a result card where a step handed one back.
 */

/**
 * Fleet waking the Admiral: an answer came in, or something happened on a
 * job. A centred line, since nobody in the conversation said it; the detail
 * under it (the question repeated in full, the event quoted) folds away.
 */
export function AdmiralEventLine({ message }: { message: AgentMessage }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const text = messageText(message);
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const body = split === -1 ? '' : unfence(text.slice(split + 2));

  return (
    <div className="flex flex-col items-center gap-1.5">
      <div className="flex max-w-full items-center gap-1.5 text-[11px] text-fleet-text-subtle">
        <BellRing size={11} className="shrink-0" />
        <span className="truncate">{head}</span>
        {body !== '' && (
          <button
            type="button"
            onClick={() => setOpen(!open)}
            aria-expanded={open}
            className="shrink-0 transition-colors hover:text-fleet-text-muted focus-ring"
          >
            {open ? 'Hide' : 'Show'}
          </button>
        )}
      </div>
      {open && (
        <p className="w-full rounded-lg border border-dashed border-fleet-border px-3 py-2 text-xs leading-relaxed whitespace-pre-wrap text-fleet-text-muted">
          {body}
        </p>
      )}
    </div>
  );
}

/**
 * The lobby's line for a job it opened, which takes the client to that job's
 * tab while the job is open, and says how it ended once it has no tab.
 */
export function JobLinkLine({ message }: { message: AgentMessage }): React.JSX.Element {
  const admiral = useAdmiralThread();
  const jobId = message.meta?.kind === 'job-link' ? message.meta.jobId : null;
  const snapshot = useAgencyStore((s) =>
    admiral === null ? undefined : s.snapshots[admiral.repoId]
  );
  const { open, ended } = jobLink(snapshot, jobId ?? -1);
  return (
    <div className="flex items-center justify-center gap-1.5 text-[11px] text-fleet-text-subtle">
      <Briefcase size={11} className="shrink-0" />
      <span className="truncate">
        {messageText(message)}
        {ended !== null && ` · ${ended}`}
      </span>
      {admiral !== null && jobId !== null && open && (
        <button
          type="button"
          onClick={() => admiral.onOpenJob(jobId)}
          className="flex shrink-0 items-center gap-0.5 text-blue-500 transition-colors hover:text-blue-400 focus-ring dark:text-blue-400 dark:hover:text-blue-300"
        >
          Open its tab
          <ArrowRight size={11} />
        </button>
      )}
    </div>
  );
}

/**
 * An `ask_client` call, drawn as the card it put up so it can be answered
 * right there. Falls back to the plain row while the call runs, when it was
 * refused, or when the question has aged out of what the pane holds.
 */
export function AskClientRow({ call }: { call: AgentToolCall }): React.JSX.Element {
  const admiral = useAdmiralThread();
  const id = askedQuestionId(call);
  const question = useAgencyStore((s) =>
    admiral === null || id === null ? null : findQuestion(s.snapshots[admiral.repoId], id)
  );
  const clientFileChanged = useAgencyStore(
    (s) => admiral !== null && s.snapshots[admiral.repoId]?.clientFileChanged === true
  );
  if (question === null || question.status === 'hidden' || call.error !== null) {
    return <AgentToolRow call={call} />;
  }
  return (
    <div className="w-full max-w-md">
      <QuestionCard
        question={question}
        onAnswer={async (answer) =>
          (await useAgencyStore.getState().answer({ id: question.id, ...answer })) !== null
        }
        onOpenSettings={() => openSettings('agencyAdmiral')}
        clientFileChanged={clientFileChanged}
      />
    </div>
  );
}

/**
 * A `settings_change` call, drawn as the card it put up, so a change can be
 * approved or undone right there. Falls back to the plain row while the call
 * runs, when nothing changed, or when the card has aged out of the snapshot.
 */
export function SettingsChangeRow({ call }: { call: AgentToolCall }): React.JSX.Element {
  const admiral = useAdmiralThread();
  const id = settingsCardId(call);
  const card = useAgencyStore((s) =>
    admiral === null || id === null
      ? null
      : (s.snapshots[admiral.repoId]?.settingsCards.find((c) => c.id === id) ?? null)
  );
  if (card === null || call.error !== null) return <AgentToolRow call={call} />;
  return (
    <div className="w-full max-w-md">
      <SettingsCardView card={card} />
    </div>
  );
}

/**
 * A tool row drawn as the card it put up, from the job detail that holds it.
 * Falls back to the plain row while the call runs, when it was refused, or
 * when no detail held has the card.
 */
function DetailCardRow<T extends { id: number }>({
  call,
  id,
  items,
  className,
  card
}: {
  call: AgentToolCall;
  id: number | null;
  items: (detail: AgencyJobDetail) => T[];
  className: string;
  card: (item: T, detail: AgencyJobDetail) => React.ReactNode;
}): React.JSX.Element {
  const admiral = useAdmiralThread();
  useJobDetail(admiral?.jobId ?? null);
  const detail = useAgencyStore((s) => (id === null ? null : detailHolding(s.details, items, id)));
  const item = detail === null ? undefined : items(detail).find((x) => x.id === id);
  if (detail === null || item === undefined || call.error !== null) {
    return <AgentToolRow call={call} />;
  }
  return <div className={`w-full ${className}`}>{card(item, detail)}</div>;
}

/**
 * A `job_plan` call, drawn as the plan card it put up, so the client can
 * decide right there. A version that is no longer waiting folds to one line.
 */
export function JobPlanRow({ call }: { call: AgentToolCall }): React.JSX.Element {
  return (
    <DetailCardRow
      call={call}
      id={proposedPlanId(call)}
      items={(detail) => detail.versions}
      className="max-w-xl"
      card={(version, detail) => <PlanCard version={version} detail={detail} />}
    />
  );
}

/** A `job_deliver` call, drawn as the result card it put up. */
export function JobDeliverRow({ call }: { call: AgentToolCall }): React.JSX.Element {
  return (
    <DetailCardRow
      call={call}
      id={deliveredResultId(call)}
      items={(detail) => detail.results}
      className="max-w-md"
      card={(result) => <ResultCard result={result} />}
    />
  );
}

/**
 * A `permission_answer` call: the line saying what the Admiral allowed or
 * denied, or the card it put to the client, answerable right there.
 */
export function PermissionAnswerRow({ call }: { call: AgentToolCall }): React.JSX.Element {
  const asked = call.summary?.startsWith('asked the client') === true;
  return (
    <DetailCardRow
      call={call}
      id={answeredPermissionId(call)}
      items={(detail) => detail.permissions}
      className={asked ? 'max-w-md' : ''}
      card={(permission, detail) =>
        asked ? (
          <PermissionCard
            permission={permission}
            paneId={detail.crew.find((c) => c.id === permission.crewId)?.paneId ?? null}
          />
        ) : (
          <PermissionLine
            permission={permission}
            decision={call.summary?.startsWith('allowed') === true ? 'allow' : 'deny'}
            reason={permission.reason}
          />
        )
      }
    />
  );
}
