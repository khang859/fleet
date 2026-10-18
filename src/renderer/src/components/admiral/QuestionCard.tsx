import { useState } from 'react';
import { ArrowUp, CircleAlert } from 'lucide-react';
import type { AgencyQuestion } from '../../../../shared/agency';
import { questionDisplayId, REMEMBER_OPTION } from '../../../../shared/agency';
import { CLIENT_LINE_MAX_CHARS } from '../../../../shared/agency-tools';
import { openClientFileSettings } from '../../store/settings-nav-store';
import { AgentMarkdown } from '../agent/AgentMarkdown';
import { ProposalLines } from './ClientFileViews';
import { useRefusable, type Refusable } from './use-refusable';

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
 * Settings. A client file card shows the lines it would change; while the
 * file has a change from outside Fleet, it cannot be approved until the
 * client keeps or reviews that change. A Remember this? card is a client file
 * card with one new line, which the client saves for this project or all of
 * them, in their own words if they type some, or keeps to this job.
 */
export function QuestionCard({
  question,
  onAnswer,
  onOpenSettings,
  clientFileChanged = false
}: {
  question: AgencyQuestion;
  /** Resolves false when main would not take the answer. */
  onAnswer: (answer: QuestionAnswer) => Promise<boolean>;
  onOpenSettings: () => void;
  /** The project's client file has a change from outside Fleet the client has not kept. */
  clientFileChanged?: boolean;
}): React.JSX.Element | null {
  const outsideChange = question.proposal !== null && clientFileChanged;
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
  const line = rememberLine(question);

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
        <AgentMarkdown
          streaming={false}
          className="text-xs leading-relaxed text-fleet-text-muted [&_code]:text-[11px]"
        >
          {question.context}
        </AgentMarkdown>
      )}
      {question.proposal !== null && line === null && (
        <ProposalLines proposal={question.proposal} />
      )}
      {settled ? (
        <>
          {line !== null && <RememberLine line={line} replaced={rewrote(question)} />}
          <Settled question={question} />
        </>
      ) : (
        <OpenAnswer
          question={question}
          line={line}
          onAnswer={onAnswer}
          withdrawn={withdrawn}
          outsideChange={outsideChange}
        />
      )}
    </section>
  );
}

/** The one line a Remember this? card offers to save, or null on any other card. */
function rememberLine(question: AgencyQuestion): string | null {
  if ((question.proposal?.topic ?? null) === null) return null;
  return question.proposal?.add[0]?.text ?? '';
}

/** The client saved a Remember this? line in words of their own. */
function rewrote(question: AgencyQuestion): boolean {
  return (question.answerText ?? '') !== '' && question.answerOption !== REMEMBER_OPTION.decline;
}

/** What an unanswered card offers: Remember this? choices or the usual options. */
function OpenAnswer({
  question,
  line,
  onAnswer,
  withdrawn,
  outsideChange
}: {
  question: AgencyQuestion;
  line: string | null;
  onAnswer: (answer: QuestionAnswer) => Promise<boolean>;
  withdrawn: boolean;
  outsideChange: boolean;
}): React.JSX.Element {
  return (
    <>
      {withdrawn && (
        <p className="text-xs text-fleet-text-subtle">
          Withdrawn{question.withdrawnReason ? `: ${question.withdrawnReason}` : ''}. You can still
          answer, and the Admiral will know it came late.
        </p>
      )}
      {outsideChange && <OutsideChange repoId={question.repoId} />}
      {line === null ? (
        <Options
          question={question}
          onAnswer={onAnswer}
          quiet={withdrawn}
          blockFirst={outsideChange}
        />
      ) : (
        <RememberOptions
          question={question}
          line={line}
          onAnswer={onAnswer}
          quiet={withdrawn}
          blockProject={outsideChange}
        />
      )}
    </>
  );
}

function OutsideChange({ repoId }: { repoId: string }): React.JSX.Element {
  return (
    <p className="text-xs text-amber-700 dark:text-amber-400/90">
      The client file changed outside Fleet.{' '}
      <button
        type="button"
        onClick={() => openClientFileSettings(repoId)}
        className="underline underline-offset-2 hover:text-fleet-text focus-ring"
      >
        Review it
      </button>{' '}
      before you approve this.
    </p>
  );
}

function Options({
  question,
  onAnswer,
  quiet,
  blockFirst = false
}: {
  question: AgencyQuestion;
  onAnswer: (answer: QuestionAnswer) => Promise<boolean>;
  /** A withdrawn question: still answerable, without the Admiral's pick lit up. */
  quiet: boolean;
  /** The first option cannot be picked right now. */
  blockFirst?: boolean;
}): React.JSX.Element {
  const [text, setText] = useState('');
  const { busy, refused, answer } = useAnswer(onAnswer, () => setText(''));

  const typed = text.trim();
  return (
    <div className="flex flex-col gap-2 pt-0.5">
      <OptionButtons
        question={question}
        quiet={quiet}
        disabled={(i) => busy || (blockFirst && i === 0)}
        onPick={(i) => void answer({ option: i })}
      />
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
      {refused && <Refused />}
    </div>
  );
}

const NOT_TAKEN: Refusable = { ok: false, reason: 'not taken' };

/** Send one answer at a time, and run `onSent` once main takes it. */
function useAnswer(
  onAnswer: (answer: QuestionAnswer) => Promise<boolean>,
  onSent: () => void
): { busy: boolean; refused: boolean; answer: (req: QuestionAnswer) => Promise<void> } {
  const { busy, refused, run } = useRefusable(async (req: QuestionAnswer) => {
    if (!(await onAnswer(req))) return NOT_TAKEN;
    onSent();
    return { ok: true } as const;
  });
  return { busy, refused: refused !== null, answer: run };
}

/** A card's options as buttons, with the Admiral's own pick marked. */
function OptionButtons({
  question,
  quiet,
  disabled,
  onPick
}: {
  question: AgencyQuestion;
  quiet: boolean;
  disabled: (option: number) => boolean;
  onPick: (option: number) => void;
}): React.JSX.Element {
  return (
    <div className="flex flex-wrap gap-1.5">
      {question.options.map((option, i) => {
        const pick = !quiet && question.recommended === i;
        return (
          <button
            key={i}
            type="button"
            disabled={disabled(i)}
            title={option.detail}
            onClick={() => onPick(i)}
            // A long option wraps rather than cutting off its own end and the pick mark.
            className={`min-h-7 max-w-full rounded-md border px-2.5 py-1 text-left text-xs transition-colors focus-ring disabled:opacity-50 ${
              pick
                ? 'border-blue-400/60 bg-fleet-surface-2 font-medium text-fleet-text hover:bg-fleet-surface-3'
                : 'border-fleet-border-strong text-fleet-text-secondary hover:bg-fleet-surface-2 hover:text-fleet-text'
            }`}
          >
            {option.label}
            {pick && <span className="whitespace-nowrap"> · My pick</span>}
          </button>
        );
      })}
    </div>
  );
}

function Refused(): React.JSX.Element {
  return (
    <p role="status" className="text-[11px] text-amber-700 dark:text-amber-400/90">
      That answer did not go through. The question may have been answered already.
    </p>
  );
}

/** The line a Remember this? card would save, struck out once the client's own words replace it. */
function RememberLine({ line, replaced }: { line: string; replaced: boolean }): React.JSX.Element {
  return (
    <p
      className={`rounded border border-fleet-border bg-fleet-surface px-2 py-1.5 text-xs leading-snug ${
        replaced ? 'text-fleet-text-subtle line-through decoration-1' : 'text-fleet-text'
      }`}
    >
      {line}
    </p>
  );
}

/**
 * Where a Remember this? line goes: This project, All projects or Just this
 * job. Words the client types replace the line, which then shows struck out.
 */
function RememberOptions({
  question,
  line,
  onAnswer,
  quiet,
  blockProject
}: {
  question: AgencyQuestion;
  line: string;
  onAnswer: (answer: QuestionAnswer) => Promise<boolean>;
  quiet: boolean;
  /** The project's file has a change from outside Fleet, so This project waits. */
  blockProject: boolean;
}): React.JSX.Element {
  const [text, setText] = useState('');
  const { busy, refused, answer } = useAnswer(onAnswer, () => setText(''));
  const typed = text.trim();
  const saves = (i: number): boolean => i !== REMEMBER_OPTION.decline;

  return (
    <div className="flex flex-col gap-2 pt-0.5">
      <RememberLine line={line} replaced={typed !== ''} />
      <label className="flex h-7 items-center gap-2 rounded-md border border-fleet-border bg-fleet-surface px-2 focus-within:border-fleet-border-strong">
        <span className="shrink-0 text-xs text-fleet-text-subtle">Or put it your way:</span>
        <input
          value={text}
          disabled={busy}
          onChange={(e) => setText(e.target.value)}
          maxLength={CLIENT_LINE_MAX_CHARS}
          aria-label={`Your own words for ${questionDisplayId(question.id)}`}
          className="min-w-0 flex-1 bg-transparent text-xs text-fleet-text outline-none placeholder:text-fleet-text-subtle"
        />
      </label>
      <OptionButtons
        question={question}
        quiet={quiet}
        disabled={(i) => busy || (blockProject && i === REMEMBER_OPTION.project)}
        onPick={(i) =>
          void answer(saves(i) && typed !== '' ? { option: i, text: typed } : { option: i })
        }
      />
      <p className="text-[11px] text-fleet-text-subtle">
        Asked once per kind of change. Ignore it and nothing is saved.
      </p>
      {refused && <Refused />}
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
        <AgentMarkdown
          streaming={false}
          className="text-xs leading-relaxed text-fleet-text-muted [&_code]:text-[11px]"
        >
          {question.context}
        </AgentMarkdown>
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
