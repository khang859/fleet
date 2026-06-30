import { useState } from 'react';
import { Eye, EyeOff, Lock, Check, AlertCircle } from 'lucide-react';
import { inputCls } from './controls';

/**
 * API-key entry field. Keys are write-only (the backend never returns them), so
 * a stored key shows an encrypted "saved" state with Replace / Remove rather
 * than a masked value. While typing a new key the eye toggle reveals it and an
 * optional `validate` runs on save. Paste is always allowed; password-manager
 * autofill is suppressed (a key is not an account password).
 */
export function SecretInput({
  present,
  onSave,
  onClear,
  placeholder,
  validate,
  inputId
}: {
  present: boolean;
  onSave: (key: string) => void | Promise<void>;
  onClear: () => void | Promise<void>;
  placeholder?: string;
  validate?: (key: string) => string | null;
  inputId?: string;
}): React.JSX.Element {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const [reveal, setReveal] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);

  const reset = (): void => {
    setValue('');
    setReveal(false);
    setError(null);
    setEditing(false);
  };

  const save = async (): Promise<void> => {
    const key = value.trim();
    if (!key) return;
    const err = validate?.(key) ?? null;
    if (err) {
      setError(err);
      return;
    }
    try {
      await onSave(key);
    } catch (e) {
      // Surface a rejected save (e.g. the key failed validation against the
      // provider) inline, and stay in the editable form so the message shows
      // even though `present` may have flipped true.
      setError(e instanceof Error ? e.message : 'Could not save. Try again.');
      setEditing(true);
      return;
    }
    reset();
    setJustSaved(true);
    setTimeout(() => setJustSaved(false), 1500);
  };

  // Saved state — no value to show, so present an encrypted badge + actions.
  if (present && !editing) {
    return (
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center gap-1.5 rounded-md border border-fleet-border bg-fleet-surface-2 px-2.5 py-1.5 text-xs text-fleet-text-secondary">
            <Lock size={12} className="text-fleet-text-muted" />
            {justSaved ? 'Saved' : 'Key stored'} · encrypted
          </span>
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="rounded-md px-2 py-1.5 text-xs text-fleet-text-secondary transition-colors hover:bg-fleet-surface-2 hover:text-fleet-text"
          >
            Replace
          </button>
          <button
            type="button"
            onClick={() => void onClear()}
            className="rounded-md px-2 py-1.5 text-xs text-red-400 transition-colors hover:bg-red-500/10"
          >
            Remove
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <input
            id={inputId}
            type={reveal ? 'text' : 'password'}
            value={value}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            name="chat-secret"
            data-1p-ignore
            placeholder={placeholder}
            onChange={(e) => {
              setValue(e.target.value);
              if (error) setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void save();
              if (e.key === 'Escape' && present) reset();
            }}
            className={`${inputCls} w-full pr-9 ${error ? 'border-red-500/60' : ''}`}
          />
          <button
            type="button"
            onClick={() => setReveal((r) => !r)}
            aria-label={reveal ? 'Hide key' : 'Show key'}
            className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1 text-fleet-text-muted transition-colors hover:text-fleet-text"
          >
            {reveal ? <EyeOff size={14} /> : <Eye size={14} />}
          </button>
        </div>
        <button
          type="button"
          onClick={() => void save()}
          disabled={!value.trim()}
          className="rounded-md fleet-accent-bg px-3 py-1.5 text-sm font-medium text-white transition active:scale-[0.97] disabled:opacity-40 disabled:active:scale-100"
        >
          Save
        </button>
        {present && (
          <button
            type="button"
            onClick={reset}
            className="rounded-md px-2 py-1.5 text-sm text-fleet-text-secondary transition-colors hover:bg-fleet-surface-2 hover:text-fleet-text"
          >
            Cancel
          </button>
        )}
      </div>
      {error ? (
        <p className="flex items-center gap-1 text-xs text-red-400">
          <AlertCircle size={12} /> {error}
        </p>
      ) : justSaved ? (
        <p className="flex items-center gap-1 text-xs text-emerald-400">
          <Check size={12} /> Saved
        </p>
      ) : null}
    </div>
  );
}
