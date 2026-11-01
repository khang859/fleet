import { useEffect, useState } from 'react';
import type { WorkflowEntry } from '../../../../shared/workflows';
import { callWorkflows, showWorkflowError } from '../../store/workflows-store';
import { ReviewLines, ReviewSections } from './ReviewSections';
import { fileLines, reviewOf, reviewSummary, type WorkflowReview } from './workflow-review';

const NEW_FILE_NOTE =
  'Fleet has not seen this file. Prompts can tell an agent to do anything, so read it first.';

const CHANGED_NOTE = 'This file changed since you approved it.';

function noteFor(entry: WorkflowEntry, review: WorkflowReview | null): string {
  if (entry.approvedText === null) return NEW_FILE_NOTE;
  return `${CHANGED_NOTE} ${review ? reviewSummary(review) : 'Read what changed.'}`;
}

function ViewSwitch({
  raw,
  onChange
}: {
  raw: boolean;
  onChange: (raw: boolean) => void;
}): React.JSX.Element {
  const views = [
    { label: 'Readable', value: false },
    { label: 'Raw file', value: true }
  ];
  return (
    <div className="flex flex-shrink-0 gap-1">
      {views.map(({ label, value }) => (
        <button
          key={label}
          type="button"
          aria-pressed={raw === value}
          onClick={() => onChange(value)}
          className={`rounded px-2.5 py-1 text-xs ${
            raw === value
              ? 'bg-fleet-surface-2 text-fleet-text'
              : 'text-fleet-text-subtle hover:text-fleet-text'
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/** Approval: what the workflow does, and what changed since a person last approved it. */
export function ChangeView({
  entry,
  onRead
}: {
  entry: WorkflowEntry;
  /** The version a person can now see, so approval covers only what they read. */
  onRead: (hash: string) => void;
}): React.JSX.Element {
  const [text, setText] = useState<string | null>(null);
  const [raw, setRaw] = useState(false);

  useEffect(() => {
    let live = true;
    callWorkflows('readText', entry.path)
      .then((read) => {
        if (!live) return;
        setText(read);
        onRead(entry.hash);
      })
      .catch(showWorkflowError);
    return () => {
      live = false;
    };
  }, [entry.path, entry.hash, onRead]);

  if (text === null) return <div />;
  const review = reviewOf(entry);

  return (
    <div className="space-y-3">
      <div className="flex items-start gap-3">
        <p className="min-w-0 flex-1 text-xs leading-relaxed text-fleet-text-secondary">
          {noteFor(entry, review)}
        </p>
        {review && <ViewSwitch raw={raw} onChange={setRaw} />}
      </div>
      {review && !raw ? (
        <ReviewSections review={review} />
      ) : (
        <ReviewLines
          lines={fileLines(entry.approvedText, text)}
          className="rounded-md border border-fleet-border font-mono text-[11px]"
        />
      )}
    </div>
  );
}
