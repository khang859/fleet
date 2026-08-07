import { useEffect, useState } from 'react';
import { ChevronRight, RotateCcw } from 'lucide-react';
import { classifierSystemPrompt } from '../../../../../shared/agent-classifier';
import { Field } from './primitives';

/**
 * What the user wants the auto-approval model to know about their setup.
 *
 * Added to the built-in instructions rather than replacing them, which is the
 * one place this differs from the system prompt field next door - see
 * `agent-classifier` for why. So there is no placeholder standing in for the
 * text being replaced: nothing is being replaced, and an empty box is an
 * accurate picture of having said nothing.
 *
 * The built-in sits underneath, closed, and is the real text rather than a
 * description of it. Somebody handing part of the say over what runs on their
 * machine to a model should be able to read what that model is told - and a
 * paraphrase would be a second copy to get out of date.
 *
 * Committed on blur rather than per keystroke: this writes to disk.
 */
export function ClassifierNoteField({
  value,
  onChange
}: {
  value: string | null;
  onChange: (value: string | null) => void;
}): React.JSX.Element {
  const [draft, setDraft] = useState(value ?? '');
  const custom = (value ?? '').trim() !== '';

  // Follow the stored value when something else changes it, e.g. Reset.
  useEffect(() => setDraft(value ?? ''), [value]);

  const commit = (): void => {
    const trimmed = draft.trim();
    const next = trimmed === '' ? null : trimmed;
    if (next !== value) onChange(next);
  };

  return (
    <Field
      label="Auto-approval notes"
      description="Added to the instructions below, for what only you know: a disposable container where installs are fine, a folder whose scripts are never ordinary."
      layout="stack"
      htmlFor="agent-classifier-note"
    >
      <textarea
        id="agent-classifier-note"
        rows={4}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        placeholder="e.g. This repo runs in a throwaway container, so installing packages is fine. Never wave through anything under ./deploy."
        spellCheck={false}
        className="w-full resize-y rounded-md border border-fleet-border bg-fleet-surface-2 px-2.5 py-2 font-mono text-xs leading-relaxed text-fleet-text outline-none transition-colors placeholder:text-fleet-text-subtle focus:border-fleet-border-strong focus-ring"
      />
      <div className="flex items-center justify-between gap-3 text-xs text-fleet-text-muted">
        <span>
          {custom ? 'Your notes are being sent.' : 'Using the built-in instructions alone.'}
        </span>
        {custom && (
          <button
            type="button"
            onClick={() => {
              setDraft('');
              onChange(null);
            }}
            className="flex shrink-0 items-center gap-1.5 rounded-md border border-fleet-border-strong px-2 py-1 text-fleet-text-secondary transition-colors hover:bg-fleet-surface-2 focus-ring"
          >
            <RotateCcw size={12} />
            Clear notes
          </button>
        )}
      </div>
      <BuiltIn />
    </Field>
  );
}

/**
 * The instructions themselves, closed by default.
 *
 * `null` rather than the current note: this is the part that does not change,
 * and showing the assembled prompt would make the box above look like it had
 * been applied twice.
 */
function BuiltIn(): React.JSX.Element {
  return (
    <details className="group rounded-md border border-fleet-border bg-fleet-surface">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 px-2.5 py-1.5 text-xs text-fleet-text-muted transition-colors hover:text-fleet-text-secondary focus-ring">
        <ChevronRight
          size={12}
          className="shrink-0 transition-transform duration-150 group-open:rotate-90"
        />
        What the model is always told
      </summary>
      <p className="border-t border-fleet-border px-2.5 py-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-fleet-text-muted">
        {classifierSystemPrompt(null)}
      </p>
    </details>
  );
}
