import { useEffect, useRef, useState } from 'react';
import { Loader2, TerminalSquare } from 'lucide-react';
import { Overlay } from '../Overlay';

type Props = {
  /** The ssh destination as the user typed it, e.g. `me@build-box`. Null closes. */
  destination: string | null;
  /** An older snippet is already on the host, so this replaces it rather than adds it. */
  update: boolean;
  /** Resolves to an error to show in place, or null once the snippet is on. */
  onInstall: () => Promise<string | null>;
  onDecline: () => void;
};

/**
 * Fleet asks before writing anything to someone else's machine.
 *
 * The dialog says exactly which two files change, because "install shell
 * integration" is the kind of phrase people agree to without knowing what it
 * touched. Declining is remembered per host, so this is asked once.
 */
export function InstallRcSnippetDialog({
  destination,
  update,
  onInstall,
  onDecline
}: Props): React.JSX.Element {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Held copy so the host name stays put through the exit animation.
  const [shown, setShown] = useState<string | null>(null);
  const declineRef = useRef<HTMLButtonElement>(null);
  // Held alongside the host name, so the wording does not change mid exit animation.
  const [shownUpdate, setShownUpdate] = useState(false);

  useEffect(() => {
    if (destination === null) return;
    setShown(destination);
    setShownUpdate(update);
    setError(null);
    setBusy(false);
    requestAnimationFrame(() => declineRef.current?.focus());
  }, [destination, update]);

  const install = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    const failure = await onInstall();
    setBusy(false);
    if (failure) {
      setError(failure);
      return;
    }
  };

  return (
    <Overlay open={destination !== null} onClose={onDecline} closeOnBackdrop={!busy}>
      <div className="w-[420px] rounded-lg border border-neutral-700 bg-neutral-900 p-4">
        <div className="flex items-start gap-2.5">
          <TerminalSquare size={16} className="mt-0.5 shrink-0 text-teal-400" />
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-neutral-200">
              {shownUpdate ? 'Update' : 'Set up'} file transfer on {shown}?
            </h3>
            <p className="mt-1 text-xs text-neutral-400">
              Drag a file onto this pane to upload it to the folder you are in, and run{' '}
              <span className="font-mono text-neutral-300">fleet get &lt;path&gt;</span> to pull one
              back down.
            </p>
            <p className="mt-1.5 text-xs text-neutral-500">
              Fleet {shownUpdate ? 'rewrites' : 'writes'}{' '}
              <span className="font-mono">~/.fleetrc.sh</span> on the host and adds one line to your{' '}
              <span className="font-mono">.bashrc</span> or{' '}
              <span className="font-mono">.zshrc</span>. Nothing else changes.
            </p>
          </div>
        </div>

        {error !== null && <div className="mt-3 text-xs text-red-400 break-words">{error}</div>}

        <div className="mt-4 flex justify-end gap-2">
          <button
            ref={declineRef}
            className="text-xs px-3 py-1 rounded bg-neutral-800 transition hover:bg-neutral-700 active:scale-[0.97] outline-none focus:ring-1 focus:ring-neutral-500"
            onClick={onDecline}
            disabled={busy}
          >
            Not now
          </button>
          <button
            className="flex items-center gap-1.5 text-xs px-3 py-1 rounded bg-teal-700 transition hover:bg-teal-600 active:scale-[0.97] disabled:opacity-50"
            onClick={() => void install()}
            disabled={busy}
          >
            {busy && <Loader2 size={12} className="animate-spin" />}
            {shownUpdate ? 'Update' : 'Set up'}
          </button>
        </div>
      </div>
    </Overlay>
  );
}
