// src/renderer/src/components/sessions/SessionsTab.tsx
import { useEffect } from 'react';
import { SessionList } from './SessionList';
import { TranscriptView } from './TranscriptView';
import { useSessionsStore } from '../../store/sessions-store';

export function SessionsTab(): React.JSX.Element {
  const load = useSessionsStore((s) => s.load);

  // Settings are loaded at app startup; the list refresh on `sessions:changed`
  // is owned by the always-mounted SessionsTabCard, so we only need an initial load here.
  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="grid h-full" style={{ gridTemplateColumns: '320px 1fr' }}>
      <SessionList />
      <TranscriptView />
    </div>
  );
}
