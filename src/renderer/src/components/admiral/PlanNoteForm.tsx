import { useState } from 'react';
import { X } from 'lucide-react';
import { PRIMARY, SECONDARY } from './JobClose';

export type NoteAction = 'revise' | 'reject';

const NOTE_FORM: Record<NoteAction, { placeholder: string; label: string; send: string }> = {
  revise: {
    placeholder: 'What should change?',
    label: 'What should change in the plan',
    send: 'Ask for the change'
  },
  reject: {
    placeholder: 'What should the Admiral do instead?',
    label: 'Why you reject the plan',
    send: 'Reject plan'
  }
};

/** A step the client pointed a change at, as a chip in the note. */
export type PointedStep = { id: string; label: string };

/**
 * The note a change or a rejection needs, in place of the card's buttons.
 * Cmd+Enter sends it and Esc cancels. A change can point at steps: the
 * reader lists them as chips, added by a click on a step.
 */
export function PlanNoteForm({
  action,
  onCancel,
  onSend,
  pointed,
  onUnpoint
}: {
  action: NoteAction;
  onCancel: () => void;
  onSend: (note: string) => void;
  /** Present where steps can be pointed at: the reader. */
  pointed?: PointedStep[];
  onUnpoint?: (id: string) => void;
}): React.JSX.Element {
  const [note, setNote] = useState('');
  const send = (): void => {
    const text = note.trim();
    if (text !== '') onSend(text);
  };
  return (
    <form
      className="flex flex-col gap-1.5 pt-0.5"
      onSubmit={(e) => {
        e.preventDefault();
        send();
      }}
    >
      {pointed !== undefined && <PointedChips pointed={pointed} onUnpoint={onUnpoint} />}
      <textarea
        value={note}
        autoFocus
        rows={2}
        onChange={(e) => setNote(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            send();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            onCancel();
          }
        }}
        placeholder={NOTE_FORM[action].placeholder}
        aria-label={NOTE_FORM[action].label}
        className="resize-none rounded-md border border-fleet-border bg-fleet-surface px-2 py-1.5 text-xs text-fleet-text outline-none placeholder:text-fleet-text-subtle focus:border-fleet-border-strong"
      />
      <div className="flex items-center justify-end gap-1.5">
        {pointed !== undefined && (
          <span className="mr-auto text-[11px] text-fleet-text-subtle">
            {window.fleet.platform === 'darwin' ? '⌘↵' : 'Ctrl+Enter'} to send · Esc to cancel
          </span>
        )}
        <button type="button" onClick={onCancel} className={SECONDARY}>
          Cancel
        </button>
        <button type="submit" disabled={note.trim() === ''} className={PRIMARY}>
          {NOTE_FORM[action].send}
        </button>
      </div>
    </form>
  );
}

/** The steps a change points at, each with a way to stop pointing at it. */
function PointedChips({
  pointed,
  onUnpoint
}: {
  pointed: PointedStep[];
  onUnpoint: ((id: string) => void) | undefined;
}): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {pointed.map((step) => (
        <span
          key={step.id}
          className="flex items-center gap-1 rounded bg-blue-500/15 py-0.5 pr-0.5 pl-1.5 text-[11px] text-blue-700 dark:text-blue-200"
        >
          {step.label}
          <button
            type="button"
            aria-label={`Stop pointing at ${step.label}`}
            onClick={() => onUnpoint?.(step.id)}
            className="flex size-4 items-center justify-center rounded transition-colors hover:bg-blue-500/20 focus-ring"
          >
            <X size={10} />
          </button>
        </span>
      ))}
      <span className="text-[11px] text-fleet-text-subtle">
        {pointed.length === 0
          ? 'Click a step to point the note at it.'
          : 'Click another step to add it.'}
      </span>
    </div>
  );
}
