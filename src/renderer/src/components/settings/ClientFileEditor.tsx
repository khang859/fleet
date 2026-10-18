import { useState } from 'react';
import type { ClientFileView } from '../../../../shared/agency-projects';

const FIELD =
  'min-w-0 rounded border border-fleet-border-strong bg-fleet-surface-3 px-2 py-1 text-sm text-fleet-text';

/**
 * One layer of the client's preferences as the Markdown it is. Saving writes
 * the whole file, so the client's own edits always win; it also keeps a change
 * made outside Fleet, which the Admiral ignores until then.
 */
export function ClientFileEditor(props: {
  layer: string;
  file: ClientFileView;
  placeholder: string;
  onSaved: () => Promise<void>;
  onCancel: () => void;
}): React.JSX.Element {
  const { file } = props;
  const [draft, setDraft] = useState(file.text ?? '');
  const [saving, setSaving] = useState(false);

  const save = async (): Promise<void> => {
    setSaving(true);
    try {
      await window.fleet.agency.projects.writeClientFile({ layer: props.layer, text: draft });
      await props.onSaved();
    } finally {
      setSaving(false);
    }
  };

  const unchanged = draft === (file.text ?? '') && !file.changedOutside;

  return (
    <div className="space-y-2">
      <textarea
        aria-label="Preferences as text"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        spellCheck={false}
        placeholder={props.placeholder}
        className={`${FIELD} block h-60 w-full resize-y font-mono text-xs leading-relaxed`}
      />
      <div className="flex items-center justify-end gap-3">
        <button
          type="button"
          onClick={props.onCancel}
          className="text-xs text-fleet-text-muted hover:text-fleet-text focus-ring"
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={saving || unchanged}
          onClick={() => void save()}
          className="rounded bg-fleet-surface-3 px-2 py-1 text-xs text-fleet-text transition active:scale-[0.97] disabled:text-fleet-text-subtle disabled:active:scale-100"
        >
          {file.changedOutside && draft === (file.text ?? '') ? 'Keep this version' : 'Save'}
        </button>
      </div>
    </div>
  );
}
