import { useState } from 'react';
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

/** The note a change or a rejection needs, in place of the card's buttons. */
export function PlanNoteForm({
  action,
  onCancel,
  onSend
}: {
  action: NoteAction;
  onCancel: () => void;
  onSend: (note: string) => void;
}): React.JSX.Element {
  const [note, setNote] = useState('');
  return (
    <form
      className="flex flex-col gap-1.5 pt-0.5"
      onSubmit={(e) => {
        e.preventDefault();
        const text = note.trim();
        if (text !== '') onSend(text);
      }}
    >
      <textarea
        value={note}
        autoFocus
        rows={2}
        onChange={(e) => setNote(e.target.value)}
        placeholder={NOTE_FORM[action].placeholder}
        aria-label={NOTE_FORM[action].label}
        className="resize-none rounded-md border border-fleet-border bg-fleet-surface px-2 py-1.5 text-xs text-fleet-text outline-none placeholder:text-fleet-text-subtle focus:border-fleet-border-strong"
      />
      <div className="flex justify-end gap-1.5">
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
