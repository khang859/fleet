import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { useRuneAssistStore } from '../../store/rune-assist-store';
import { detectIntent } from '../../../../shared/rune-assist';
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
  const setModeOverride = useRuneAssistStore((s) => s.setModeOverride);

  const handleDismiss = useCallback(() => dismissAnswer(paneId), [dismissAnswer, paneId]);
  const handleStop = useCallback(() => void stop(paneId), [stop, paneId]);

  const layerRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  const [pos, setPos] = useState<{ top: number; left: number }>({
    top: pane?.anchor?.top ?? 8,
    left: pane?.anchor?.left ?? 8
  });

  useLayoutEffect(() => {
    const layer = layerRef.current;
    const box = boxRef.current;
    if (!layer || !box) return;
    const pad = 8;
    const maxLeft = Math.max(pad, layer.clientWidth - box.offsetWidth - pad);
    const maxTop = Math.max(pad, layer.clientHeight - box.offsetHeight - pad);
    const rawTop = pane?.anchor?.top ?? 8;
    const rawLeft = pane?.anchor?.left ?? 8;
    const next = {
      top: Math.min(Math.max(pad, rawTop), maxTop),
      left: Math.min(Math.max(pad, rawLeft), maxLeft)
    };
    setPos((prev) => (prev.top === next.top && prev.left === next.left ? prev : next));
  }, [
    pane?.anchor?.top,
    pane?.anchor?.left,
    pane?.phase,
    pane?.answer,
    pane?.open,
    pane?.lastEdited
  ]);

  if (!pane) return null;

  const effectiveMode = pane.modeOverride ?? detectIntent(pane.draft);

  const anchorStyle: React.CSSProperties = {
    position: 'absolute',
    top: pos.top,
    left: pos.left,
    zIndex: 30
  };

  return (
    <div ref={layerRef} className="pointer-events-none absolute inset-0">
      <div ref={boxRef} className="pointer-events-auto" style={anchorStyle}>
        {pane.phase === 'working' ? (
          <RuneWorkingPill step={pane.step} startedAt={pane.startedAt} onStop={handleStop} />
        ) : pane.answer !== null ? (
          <RuneAnswerPopover answer={pane.answer} onDismiss={handleDismiss} />
        ) : pane.open ? (
          <div className="flex flex-col gap-1.5">
            <RuneAssistOverlay
              draft={pane.draft}
              onChange={(v) => setDraft(paneId, v)}
              onSubmit={() => void send(paneId, pane.draft)}
              onClose={() => closeOverlay(paneId)}
              mode={effectiveMode}
              onToggleMode={() =>
                setModeOverride(paneId, effectiveMode === 'edit' ? 'ask' : 'edit')
              }
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
