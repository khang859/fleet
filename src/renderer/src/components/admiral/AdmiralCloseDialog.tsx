import { useEffect, useRef, useState } from 'react';
import { AdmiralGlyph } from './AdmiralGlyph';
import { useWorkspaceStore } from '../../store/workspace-store';
import { finishAdmiralClose } from './admiral-close';
import { Overlay } from '../Overlay';

/**
 * Closing an Admiral whose jobs are still running. The jobs live in main, so
 * closing the pane does not have to stop them: the client either keeps them
 * running - the Admiral is paused until a pane for the repository opens again
 * and picks up where it left off - or cancels them. Escape keeps the pane.
 */
export function AdmiralCloseDialog(): React.JSX.Element {
  const confirm = useWorkspaceStore((s) => s.admiralCloseConfirm);
  const keepRef = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState(false);
  // The last one asked, so the words stay put while the dialog fades out.
  const shown = useRef(confirm);
  if (confirm !== null) shown.current = confirm;

  useEffect(() => {
    if (confirm === null) return;
    requestAnimationFrame(() => keepRef.current?.focus());
  }, [confirm]);

  const finish = (cancelJobs: boolean): void => {
    if (confirm === null || busy) return;
    setBusy(true);
    void finishAdmiralClose(confirm, cancelJobs).finally(() => setBusy(false));
  };
  const running = shown.current?.running ?? 0;

  return (
    <Overlay
      open={confirm !== null}
      onClose={() => useWorkspaceStore.getState().setAdmiralCloseConfirm(null)}
    >
      <div
        role="dialog"
        aria-labelledby="admiral-close-title"
        className="w-[420px] rounded-lg border border-fleet-border-strong bg-fleet-surface-2 p-4 shadow-xl"
      >
        <div className="flex items-start gap-2.5">
          <AdmiralGlyph size={16} className="mt-0.5 shrink-0" />
          <div className="min-w-0">
            <h3 id="admiral-close-title" className="text-sm font-semibold text-fleet-text">
              Close the Admiral for {shown.current?.repoName}?
            </h3>
            <p className="mt-1 text-xs text-fleet-text-muted">
              {running === 1 ? 'One job is' : `${running} jobs are`} still running. They can keep
              running without this pane: the Admiral pauses, and picks up where it left off when you
              open it again.
            </p>
          </div>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => useWorkspaceStore.getState().setAdmiralCloseConfirm(null)}
            className="focus-ring mr-auto rounded px-3 py-1 text-xs whitespace-nowrap text-fleet-text-muted transition hover:bg-fleet-surface-3 hover:text-fleet-text active:scale-[0.97]"
          >
            Don&apos;t close
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => finish(true)}
            className="focus-ring rounded px-3 py-1 text-xs whitespace-nowrap text-red-500 transition hover:bg-fleet-surface-3 hover:text-red-400 active:scale-[0.97] disabled:opacity-50"
          >
            Cancel jobs
          </button>
          <button
            ref={keepRef}
            type="button"
            disabled={busy}
            onClick={() => finish(false)}
            className="focus-ring-offset rounded bg-fleet-surface-3 px-3 py-1 text-xs font-medium whitespace-nowrap text-fleet-text transition hover:bg-fleet-border-strong active:scale-[0.97] disabled:opacity-50"
          >
            Keep running, Admiral paused
          </button>
        </div>
      </div>
    </Overlay>
  );
}
