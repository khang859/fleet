import { useCallback, useEffect, useRef, useState } from 'react';
import {
  HISTORY_IDLE,
  historyStep,
  type AgentHistoryCursor,
  type HistoryDirection
} from '../../../../shared/agent-history';

/**
 * The prompts typed against this folder, and where Up has got to in them.
 *
 * Loaded once per folder and then kept in the renderer, so a press of Up is
 * answered from memory rather than across IPC - the list is a hundred short
 * strings, and a keypress that waits on a round trip does not feel like a
 * keypress.
 *
 * Deliberately not part of the thread. What you have typed is a property of the
 * folder rather than of the conversation, which is why `/clear` leaves it alone
 * and why a new pane on a folder you have worked in before starts with it all
 * there.
 */
export function usePromptHistory(cwd: string): {
  /** The new text for the box, or `null` when the press was not ours. */
  step: (direction: HistoryDirection, current: string) => string | null;
  /** Stop walking: what is in the box now is live text again. */
  reset: () => void;
  /** Take a sent prompt into the list, in front of everything else. */
  remember: (text: string) => void;
} {
  const [entries, setEntries] = useState<string[]>([]);
  const cursor = useRef<AgentHistoryCursor>(HISTORY_IDLE);

  useEffect(() => {
    let live = true;
    cursor.current = HISTORY_IDLE;
    setEntries([]);
    void window.fleet.agent.historyList(cwd).then((list) => {
      if (live) setEntries(list);
    });
    return () => {
      live = false;
    };
  }, [cwd]);

  const step = useCallback(
    (direction: HistoryDirection, current: string): string | null => {
      const next = historyStep(cursor.current, direction, entries, current);
      if (next === null) return null;
      cursor.current = next.cursor;
      return next.text;
    },
    [entries]
  );

  const reset = useCallback((): void => {
    cursor.current = HISTORY_IDLE;
  }, []);

  const remember = useCallback(
    (text: string): void => {
      const trimmed = text.trim();
      if (trimmed === '') return;
      window.fleet.agent.historyAdd(cwd, trimmed);
      // Kept in step with what main will have written rather than re-read: the
      // same collapsing rules, applied to the copy already in hand.
      setEntries((current) => [trimmed, ...current.filter((entry) => entry !== trimmed)]);
      cursor.current = HISTORY_IDLE;
    },
    [cwd]
  );

  return { step, reset, remember };
}
