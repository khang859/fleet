import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useRuneAssistStore } from '../../store/rune-assist-store';
import { getEditorHandle } from '../../lib/editor-context-registry';
import { clampOverlayPosition, detectIntent } from '../../../../shared/rune-assist';
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

  // Revert overwrites the buffer with the pre-rune snapshot AND persists it. If the user
  // typed manual edits after rune's edit landed, that's silent data loss — so require a
  // confirm click when the buffer is dirty.
  const [confirmRevert, setConfirmRevert] = useState(false);
  const handleRevert = useCallback(() => {
    const dirty = getEditorHandle(paneId)?.isClean() === false;
    if (dirty && !confirmRevert) {
      setConfirmRevert(true);
      return;
    }
    setConfirmRevert(false);
    void revert(paneId);
  }, [paneId, revert, confirmRevert]);

  const layerRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  const [pos, setPos] = useState<{ top: number; left: number }>({
    top: pane?.anchor?.top ?? 8,
    left: pane?.anchor?.left ?? 8
  });
  // Hidden (visibility, NOT unmounted) when the anchored line scrolls out of view, so an
  // in-flight turn survives. Reappears when the line scrolls back. See research: follow,
  // clamp, hide-when-clipped is the cross-library consensus.
  const [hidden, setHidden] = useState(false);

  const anchorPos = pane?.anchorPos ?? null;
  const fallbackTop = pane?.anchor?.top ?? 8;
  const fallbackLeft = pane?.anchor?.left ?? 8;

  useLayoutEffect(() => {
    const layer = layerRef.current;
    const box = boxRef.current;
    if (!layer || !box) return;

    const recompute = (): void => {
      let rawTop = fallbackTop;
      let rawLeft = fallbackLeft;
      const handle = getEditorHandle(paneId);
      if (handle && anchorPos !== null) {
        const c = handle.coordsForPos(anchorPos);
        if (!c) {
          // Line is outside the rendered range — keep position, just hide.
          setHidden((prev) => (prev ? prev : true));
          return;
        }
        rawTop = c.top;
        rawLeft = c.left;
        setHidden((prev) => (prev === !c.visible ? prev : !c.visible));
      } else {
        setHidden((prev) => (prev ? false : prev));
      }
      const next = clampOverlayPosition({
        rawTop,
        rawLeft,
        layerWidth: layer.clientWidth,
        layerHeight: layer.clientHeight,
        boxWidth: box.offsetWidth,
        boxHeight: box.offsetHeight,
        pad: 8
      });
      setPos((prev) => (prev.top === next.top && prev.left === next.left ? prev : next));
    };

    recompute();
    const off = getEditorHandle(paneId)?.onScroll(recompute);
    window.addEventListener('resize', recompute);
    return () => {
      off?.();
      window.removeEventListener('resize', recompute);
    };
  }, [
    paneId,
    anchorPos,
    fallbackTop,
    fallbackLeft,
    pane?.phase,
    pane?.answer,
    pane?.open,
    pane?.lastEdited,
    // Re-subscribe if the pane swaps to a different file (new EditorView/scrollDOM).
    pane?.contextFile
  ]);

  // Drop a pending confirm if the Revert affordance is no longer showing.
  useEffect(() => {
    if (!pane?.lastEdited) setConfirmRevert(false);
  }, [pane?.lastEdited]);

  if (!pane) return null;

  const effectiveMode = pane.modeOverride ?? detectIntent(pane.draft);

  const anchorStyle: React.CSSProperties = {
    position: 'absolute',
    top: pos.top,
    left: pos.left,
    zIndex: 30,
    visibility: hidden ? 'hidden' : 'visible'
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
            onClick={handleRevert}
            className={`rounded-full border px-3 py-1 text-xs shadow-xl ring-1 ring-white/15 ${
              confirmRevert
                ? 'border-amber-700/70 bg-amber-950/40 text-amber-300 hover:text-amber-200'
                : 'border-fleet-border-strong bg-fleet-surface-2 text-emerald-300 hover:text-emerald-200'
            }`}
          >
            {confirmRevert ? '⚠ Discard unsaved edits? · Confirm' : '⟳ Reloaded · Revert'}
          </button>
        ) : null}
      </div>
    </div>
  );
}
