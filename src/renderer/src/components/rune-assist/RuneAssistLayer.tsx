import { useCallback } from 'react';
import { useRuneAssistStore } from '../../store/rune-assist-store';
import { RuneAssistOverlay } from './RuneAssistOverlay';
import { RuneWorkingPill } from './RuneWorkingPill';
import { RuneAnswerPopover } from './RuneAnswerPopover';

type Props = { paneId: string };

/** Renders the right transient piece (overlay / pill / popover / revert) for one file pane. */
export function RuneAssistLayer({ paneId }: Props): React.JSX.Element | null {
  const pane = useRuneAssistStore((s) => s.panes[paneId]);
  const setDraft = useRuneAssistStore((s) => s.setDraft);
  const send = useRuneAssistStore((s) => s.send);
  const stop = useRuneAssistStore((s) => s.stop);
  const closeOverlay = useRuneAssistStore((s) => s.closeOverlay);
  const dismissAnswer = useRuneAssistStore((s) => s.dismissAnswer);
  const revert = useRuneAssistStore((s) => s.revert);

  const handleDismiss = useCallback(() => dismissAnswer(paneId), [dismissAnswer, paneId]);
  const handleStop = useCallback(() => void stop(paneId), [stop, paneId]);

  if (!pane) return null;

  const anchorStyle: React.CSSProperties = {
    position: 'absolute',
    top: pane.anchor?.top ?? 8,
    left: pane.anchor?.left ?? 8,
    zIndex: 30
  };

  return (
    <div className="pointer-events-none absolute inset-0">
      <div className="pointer-events-auto" style={anchorStyle}>
        {pane.phase === 'working' ? (
          <RuneWorkingPill step={pane.step} onStop={handleStop} />
        ) : pane.answer !== null ? (
          <RuneAnswerPopover answer={pane.answer} onDismiss={handleDismiss} />
        ) : pane.open ? (
          <div className="flex flex-col gap-1.5">
            <RuneAssistOverlay
              draft={pane.draft}
              onChange={(v) => setDraft(paneId, v)}
              onSubmit={() => void send(paneId, pane.draft)}
              onClose={() => closeOverlay(paneId)}
            />
            {pane.phase === 'error' && pane.error && (
              <div className="w-80 rounded-md border border-red-900/60 bg-red-950/40 px-3 py-1.5 text-xs text-red-300">
                {pane.error} · edit your prompt and press ⏎ to retry
              </div>
            )}
          </div>
        ) : pane.lastEdited ? (
          <button
            onClick={() => void revert(paneId)}
            className="rounded-full border border-fleet-border bg-fleet-surface-2 px-3 py-1 text-xs text-emerald-300 shadow-lg hover:text-emerald-200"
          >
            ⟳ Reloaded · Revert
          </button>
        ) : null}
      </div>
    </div>
  );
}
