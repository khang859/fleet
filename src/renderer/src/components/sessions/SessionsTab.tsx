// src/renderer/src/components/sessions/SessionsTab.tsx
import { useEffect, useState } from 'react';
import { SessionList } from './SessionList';
import { TranscriptView } from './TranscriptView';
import { LearningsBrowser } from './LearningsBrowser';
import { useSessionsStore } from '../../store/sessions-store';
import { useToastStore } from '../../store/toast-store';
import type { Learning } from '../../../../shared/learnings';

type View = 'sessions' | 'learnings';

export function SessionsTab(): React.JSX.Element {
  const load = useSessionsStore((s) => s.load);
  const sessions = useSessionsStore((s) => s.sessions);
  const select = useSessionsStore((s) => s.select);
  const [view, setView] = useState<View>('sessions');
  // Bumped after a distill saves so the (possibly already-mounted) Learnings list
  // refetches instead of showing a stale list until the user types in search.
  const [learningsRefreshKey, setLearningsRefreshKey] = useState(0);

  // Settings are loaded at app startup; the list refresh on `sessions:changed`
  // is owned by the always-mounted SessionsTabCard, so we only need an initial load here.
  useEffect(() => {
    void load();
  }, [load]);

  // Jump from a learning back to the session it was distilled from (best-effort:
  // the session may no longer exist).
  function openSource(l: Learning): void {
    const match = sessions.find(
      (s) => s.agent === l.sourceAgent && s.id === l.sourceSessionId && s.cwd === l.sourceCwd
    );
    if (match) {
      void select(match);
      setView('sessions');
    } else {
      useToastStore.getState().show('That source session no longer exists.');
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-shrink-0 items-center gap-1 border-b border-fleet-border px-3 py-1.5">
        {(['sessions', 'learnings'] as const).map((v) => (
          <button
            key={v}
            onClick={() => setView(v)}
            className={`rounded px-2.5 py-1 text-xs font-medium capitalize ${
              view === v
                ? 'bg-fleet-surface-2 text-fleet-text'
                : 'text-fleet-text-subtle hover:bg-fleet-surface-2/50'
            }`}
          >
            {v}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1">
        {view === 'sessions' ? (
          <div
            className="grid h-full"
            style={{ gridTemplateColumns: '320px 1fr', gridTemplateRows: 'minmax(0, 1fr)' }}
          >
            <SessionList />
            <TranscriptView onDistilled={() => setLearningsRefreshKey((k) => k + 1)} />
          </div>
        ) : (
          <LearningsBrowser onOpenSource={openSource} refreshKey={learningsRefreshKey} />
        )}
      </div>
    </div>
  );
}
