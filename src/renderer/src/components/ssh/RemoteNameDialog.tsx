import { useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Overlay } from '../Overlay';
import { validateRemoteName } from '../../lib/remote-names';

export type NameRequest = {
  title: string;
  /** Field label, e.g. "Folder name". */
  label: string;
  initialValue: string;
  confirmLabel: string;
};

type Props = {
  request: NameRequest | null;
  /** Resolves to an error to show in place, or null once the work is done. */
  onSubmit: (value: string) => Promise<string | null>;
  onClose: () => void;
};

/** Everything up to the extension, which is what a rename normally replaces. */
function stemLength(name: string): number {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? dot : name.length;
}

/** Shared prompt for "New folder" and "Rename". */
export function RemoteNameDialog({ request, onSubmit, onClose }: Props): React.JSX.Element {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Held copy so the panel still has its text and title through the exit animation.
  const [shown, setShown] = useState<NameRequest | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const wasOpen = useRef(false);

  useEffect(() => {
    // Seed only on the transition into open. `request` is rebuilt whenever the
    // pane it describes changes, and reseeding on that would wipe what the user
    // has typed out from under them.
    if (!request || wasOpen.current) {
      wasOpen.current = request !== null;
      return;
    }
    wasOpen.current = true;
    setShown(request);
    setValue(request.initialValue);
    setError(null);
    setBusy(false);
    // Rename opens with the stem selected, so typing replaces the name but
    // keeps the extension - retyping ".tsx" every time is pure friction.
    requestAnimationFrame(() => {
      const input = inputRef.current;
      if (!input) return;
      input.focus();
      input.setSelectionRange(0, stemLength(request.initialValue));
    });
  }, [request]);

  const submit = async (): Promise<void> => {
    if (busy) return;
    const invalid = validateRemoteName(value);
    if (invalid) {
      setError(invalid);
      return;
    }
    setBusy(true);
    const failure = await onSubmit(value.trim());
    setBusy(false);
    if (failure) {
      setError(failure);
      inputRef.current?.focus();
      return;
    }
    onClose();
  };

  return (
    <Overlay open={request !== null} onClose={onClose} closeOnBackdrop={!busy}>
      <div className="w-[380px] rounded-lg border border-neutral-700 bg-neutral-900 p-4">
        <h3 className="text-sm font-semibold text-neutral-200">{shown?.title}</h3>

        <label className="mt-3 block text-xs text-neutral-500" htmlFor="remote-name-input">
          {shown?.label}
        </label>
        <input
          id="remote-name-input"
          ref={inputRef}
          className="mt-1 w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1.5 text-sm text-neutral-200 outline-none focus:border-teal-600"
          value={value}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => {
            setValue(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void submit();
            }
          }}
        />

        {error !== null && <div className="mt-2 text-xs text-red-400">{error}</div>}

        <div className="mt-4 flex justify-end gap-2">
          <button
            className="text-xs px-3 py-1 rounded bg-neutral-800 transition hover:bg-neutral-700 active:scale-[0.97]"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            className="flex items-center gap-1.5 text-xs px-3 py-1 rounded bg-teal-700 transition hover:bg-teal-600 active:scale-[0.97] disabled:opacity-50"
            onClick={() => void submit()}
            disabled={busy || value.trim().length === 0}
          >
            {busy && <Loader2 size={12} className="animate-spin" />}
            {shown?.confirmLabel}
          </button>
        </div>
      </div>
    </Overlay>
  );
}
