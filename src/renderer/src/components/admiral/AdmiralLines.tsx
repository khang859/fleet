import { useState } from 'react';
import { ArrowRight, BellRing, Briefcase } from 'lucide-react';
import type { AgentToolCall } from '../../../../shared/agent-tools';
import type { AgentMessage } from '../../../../shared/agent-types';
import { messageText } from '../../../../shared/agent-types';
import { unfence } from '../../../../shared/fleet-tools';
import { findQuestion, useAgencyStore } from '../../store/agency-store';
import { openSettings } from '../../store/settings-nav-store';
import { AgentToolRow } from '../agent/AgentToolRow';
import { useAdmiralThread } from './admiral-context';
import { QuestionCard } from './QuestionCard';
import { askedQuestionId } from './job-view';

/**
 * The lines an Admiral transcript has that an Agent one does not: what woke
 * the Admiral, a job opened from the lobby, and a question card where the
 * Admiral asked one.
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

/** The lobby's line for a job it opened, which takes the client to that job's tab. */
export function JobLinkLine({ message }: { message: AgentMessage }): React.JSX.Element {
  const admiral = useAdmiralThread();
  const jobId = message.meta?.kind === 'job-link' ? message.meta.jobId : null;
  return (
    <div className="flex items-center justify-center gap-1.5 text-[11px] text-fleet-text-subtle">
      <Briefcase size={11} className="shrink-0" />
      <span className="truncate">{messageText(message)}</span>
      {admiral !== null && jobId !== null && (
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
      />
    </div>
  );
}
