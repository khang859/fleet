import { useEffect } from 'react';
import { useRuneAssistStore } from '../store/rune-assist-store';

/**
 * Subscribe ONCE (app-level) to Rune Quick-Assist status/result events and route them into
 * the store by paneId. This must live above the file panes: a `FileEditorPane` unmounts when
 * its tab is switched away, so a per-pane subscription would miss the turn's terminal
 * (idle/result/error) event while the tab is in the background — leaving the pill stuck on
 * "working" forever. The store is a singleton that survives tab switches, so routing here
 * keeps it correct regardless of which pane is mounted.
 */
export function useRuneAssistEvents(): void {
  useEffect(() => {
    // Stable store actions — grab via getState so the effect subscribes exactly once.
    const { applyStatus, applyResult } = useRuneAssistStore.getState();
    const offStatus = window.fleet.runeAssist.onStatus((p) =>
      applyStatus(p.paneId, { phase: p.phase, step: p.step, error: p.error })
    );
    const offResult = window.fleet.runeAssist.onResult((p) => applyResult(p.paneId, p));
    return () => {
      offStatus();
      offResult();
    };
  }, []);
}
