import { useState } from 'react';
import { ArrowUp, CircleAlert } from 'lucide-react';
import type { AgencyQuestion } from '../../../../shared/agency';
import { questionDisplayId } from '../../../../shared/agency';

/** What answering a card sends: an option, words, or both. */
export type QuestionAnswer = { option?: number; text?: string };

/**
 * One question the Admiral put to the client, as a card: the question, the
 * context to answer it without scrolling back, two to four options with the
 * Admiral's own pick marked, and a line for an answer of the client's own.
 *
 * The same card in the job sheet and in the conversation, so answering either
 * answers both. A question withdrawn before it was answered can still be
 * answered - the Admiral is told it came late - and one that is settled says
 * how. The model-unreachable card is the one that is not the Admiral's: it is
 * Fleet saying the model cannot be reached, and its buttons retry or go to
 * Settings.
 */
export function QuestionCard({
  question,
  onAnswer,
  onOpenSettings
}: {
  question: AgencyQuestion;
  /** Resolves false when main would not take the answer. */
  onAnswer: (answer: QuestionAnswer) => Promise<boolean>;
  onOpenSettings: () => void;
}): React.JSX.Element | null {
  if (question.status === 'hidden') return null;
  if (question.kind === 'model_unreachable') {
    return (
      <ModelUnreachableCard
        question={question}
        onAnswer={onAnswer}
        onOpenSettings={onOpenSettings}
      />
    );
  }
  const settled = question.answeredAt !== null;
  const withdrawn = question.status === 'withdrawn' && !settled;

  return (
    <section
      aria-label={`Question ${questionDisplayId(question.id)}`}
      className={`flex flex-col gap-1.5 rounded-md border bg-fleet-bg p-2.5 ${
        question.status === 'open' ? 'border-amber-400/35' : 'border-fleet-border'
      }`}
    >
      <div className="flex items-baseline gap-2">
        <span
          className={`flex-1 text-[13px] font-medium ${settled || withdrawn ? 'text-fleet-text-secondary' : 'text-fleet-text'}`}
        >
          {question.question}
        </span>
        <span className="shrink-0 font-mono text-[11px] text-fleet-text-subtle">
          {questionDisplayId(question.id)}
        </span>
      </div>
      {question.context !== '' && (
        <p className="text-xs leading-relaxed whitespace-pre-wrap text-fleet-text-muted">
          {question.context}
        </p>
      )}
      {settled ? (
        <Settled question={question} />
      ) : (
        <>
          {withdrawn && (
            <p className="text-xs text-fleet-text-subtle">
              Withdrawn{question.withdrawnReason ? `: ${question.withdrawnReason}` : ''}. You can
              still answer, and the Admiral will know it came late.
            </p>
          )}
          <Options question={question} onAnswer={onAnswer} quiet={withdrawn} />
        </>
      )}
    </section>
  );
}

function Options({
  question,
  onAnswer,
  quiet
}: {
  question: AgencyQuestion;
  onAnswer: (answer: QuestionAnswer) => Promise<boolean>;
  /** A withdrawn question: still answerable, without the Admiral's pick lit up. */
  quiet: boolean;
}): React.JSX.Element {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState(false);

  const answer = async (req: QuestionAnswer): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setRefused(false);
    const ok = await onAnswer(req).catch(() => false);
    setBusy(false);
    if (ok) setText('');
    else setRefused(true);
  };

  const typed = text.trim();
  return (
    <div className="flex flex-col gap-2 pt-0.5">
      <div className="flex flex-wrap gap-1.5">
        {question.options.map((option, i) => {
          const pick = !quiet && question.recommended === i;
          return (
            <button
              key={i}
              type="button"
              disabled={busy}
              title={option.detail}
              onClick={() => void answer({ option: i })}
              className={`h-7 max-w-full truncate rounded-md border px-2.5 text-xs transition-colors focus-ring disabled:opacity-50 ${
                pick
                  ? 'border-blue-400/60 bg-fleet-surface-2 font-medium text-fleet-text hover:bg-fleet-surface-3'
                  : 'border-fleet-border-strong text-fleet-text-secondary hover:bg-fleet-surface-2 hover:text-fleet-text'
              }`}
            >
              {pick ? `${option.label} · My pick` : option.label}
            </button>
          );
        })}
      </div>
      <form
        className="flex h-7 items-center gap-1 rounded-md border border-fleet-border bg-fleet-surface pr-0.5 pl-2 focus-within:border-fleet-border-strong"
        onSubmit={(e) => {
          e.preventDefault();
          if (typed !== '') void answer({ text: typed });
        }}
      >
        <input
          value={text}
          disabled={busy}
          onChange={(e) => setText(e.target.value)}
          placeholder="Or answer in your own words"
          aria-label={`Your own answer to ${questionDisplayId(question.id)}`}
          className="min-w-0 flex-1 bg-transparent text-xs text-fleet-text outline-none placeholder:text-fleet-text-subtle"
        />
        <button
          type="submit"
          disabled={busy || typed === ''}
          aria-label="Send answer"
          className="flex size-6 shrink-0 items-center justify-center rounded text-fleet-text-muted transition-colors hover:bg-fleet-surface-2 hover:text-fleet-text disabled:opacity-30 focus-ring"
        >
          <ArrowUp size={13} />
        </button>
      </form>
      {refused && (
        <p role="status" className="text-[11px] text-amber-700 dark:text-amber-400/90">
          That answer did not go through. The question may have been answered already.
        </p>
      )}
    </div>
  );
}

/** How a question was answered, and whether it came late. */
function Settled({ question }: { question: AgencyQuestion }): React.JSX.Element {
  const option = question.answerOption === null ? null : question.options[question.answerOption];
  const said = [option?.label, question.answerText].filter((s): s is string => !!s).join(' - ');
  return (
    <p className="text-xs text-fleet-text-muted">
      <span className="text-fleet-text-subtle">You answered </span>
      <span className="text-fleet-text-secondary">{said || 'it'}</span>
      {question.late && (
        <span className="text-fleet-text-subtle">
          {' '}
          · after it was withdrawn, so the Admiral was told it came late
        </span>
      )}
    </p>
  );
}

function ModelUnreachableCard({
  question,
  onAnswer,
  onOpenSettings
}: {
  question: AgencyQuestion;
  onAnswer: (answer: QuestionAnswer) => Promise<boolean>;
  onOpenSettings: () => void;
}): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const open = question.status === 'open' && question.answeredAt === null;
  return (
    <section
      aria-label="The Admiral cannot reach its model"
      className={`flex flex-col gap-1.5 rounded-md border bg-fleet-bg p-2.5 ${
        open ? 'border-amber-400/35' : 'border-fleet-border'
      }`}
    >
      <div className="flex items-center gap-1.5 text-[13px] font-medium text-fleet-text">
        <CircleAlert size={13} className="shrink-0 text-amber-700 dark:text-amber-400" />
        {question.question}
      </div>
      {question.context !== '' && (
        <p className="text-xs leading-relaxed break-words text-fleet-text-muted">
          {question.context}
        </p>
      )}
      {open ? (
        <div className="flex flex-wrap gap-1.5 pt-0.5">
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void onAnswer({ option: 0 }).finally(() => setBusy(false));
            }}
            className="h-7 rounded-md border border-blue-400/60 bg-fleet-surface-2 px-2.5 text-xs font-medium text-fleet-text transition-colors hover:bg-fleet-surface-3 focus-ring disabled:opacity-50"
          >
            Retry
          </button>
          <button
            type="button"
            onClick={onOpenSettings}
            className="h-7 rounded-md border border-fleet-border-strong px-2.5 text-xs text-fleet-text-secondary transition-colors hover:bg-fleet-surface-2 hover:text-fleet-text focus-ring"
          >
            Open Settings
          </button>
        </div>
      ) : (
        <p className="text-xs text-fleet-text-subtle">
          {question.answeredAt === null ? 'The model answered again.' : 'Retried.'}
        </p>
      )}
    </section>
  );
}
