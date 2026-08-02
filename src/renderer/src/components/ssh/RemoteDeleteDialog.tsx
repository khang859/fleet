import { useEffect, useRef, useState } from 'react';
import { Loader2, TriangleAlert } from 'lucide-react';
import type { RemoteDirEntry } from '../../../../shared/remote-ssh-types';
import { Overlay } from '../Overlay';

type Props = {
  entry: RemoteDirEntry | null;
  hostLabel: string;
  /** Resolves to an error to show in place, or null once the entry is gone. */
  onConfirm: () => Promise<string | null>;
  onClose: () => void;
};

/**
 * Confirmation for a permanent remote delete.
 *
 * There is no trash on the far side - SFTP `rm` is final - so the dialog says so
 * outright rather than relying on the user to know it. Cancel holds focus: the
 * safe choice is the one a reflexive Return or Escape lands on.
 */
export function RemoteDeleteDialog({
  entry,
  hostLabel,
  onConfirm,
  onClose
}: Props): React.JSX.Element {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Held copy so the name stays put through the exit animation.
  const [shown, setShown] = useState<RemoteDirEntry | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!entry) return;
    setShown(entry);
    setError(null);
    setBusy(false);
    requestAnimationFrame(() => cancelRef.current?.focus());
  }, [entry]);

  const confirm = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    const failure = await onConfirm();
    setBusy(false);
    if (failure) {
      setError(failure);
      return;
    }
    onClose();
  };

  const isDir = shown?.kind === 'dir';

  return (
    <Overlay open={entry !== null} onClose={onClose} closeOnBackdrop={!busy}>
      <div className="w-[400px] rounded-lg border border-neutral-700 bg-neutral-900 p-4">
        <div className="flex items-start gap-2.5">
          <TriangleAlert size={16} className="mt-0.5 shrink-0 text-red-400" />
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-neutral-200">
              Delete {isDir ? 'folder' : shown?.kind === 'symlink' ? 'link' : 'file'}?
            </h3>
            <p className="mt-1 text-xs text-neutral-400 break-words">
              <span className="font-mono text-neutral-300">{shown?.name}</span>
              {isDir && ' and everything inside it'} will be removed from {hostLabel}.
            </p>
            <p className="mt-1.5 text-xs text-neutral-500">
              There is no trash on the remote host. This cannot be undone.
            </p>
          </div>
        </div>

        {error !== null && <div className="mt-3 text-xs text-red-400 break-words">{error}</div>}

        <div className="mt-4 flex justify-end gap-2">
          <button
            ref={cancelRef}
            className="text-xs px-3 py-1 rounded bg-neutral-800 transition hover:bg-neutral-700 active:scale-[0.97] outline-none focus:ring-1 focus:ring-neutral-500"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            className="flex items-center gap-1.5 text-xs px-3 py-1 rounded bg-red-700 transition hover:bg-red-600 active:scale-[0.97] disabled:opacity-50"
            onClick={() => void confirm()}
            disabled={busy}
          >
            {busy && <Loader2 size={12} className="animate-spin" />}
            Delete
          </button>
        </div>
      </div>
    </Overlay>
  );
}
