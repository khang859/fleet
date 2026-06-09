// src/renderer/src/components/sessions/SessionsTab.tsx
import { useEffect } from 'react';
import { SessionList } from './SessionList';
import { TranscriptView } from './TranscriptView';
import { useSessionsStore } from '../../store/sessions-store';
import { useSettingsStore } from '../../store/settings-store';

export function SessionsTab(): React.JSX.Element {
  const load = useSessionsStore((s) => s.load);
  const settingsLoaded = useSettingsStore((s) => s.isLoaded);
  const loadSettings = useSettingsStore((s) => s.loadSettings);

  useEffect(() => {
    if (!settingsLoaded) void loadSettings();
  }, [settingsLoaded, loadSettings]);

  useEffect(() => {
    void load();
    const cleanup = window.fleet.sessions.onChanged(() => void load());
    return cleanup;
  }, [load]);

  return (
    <div className="grid h-full" style={{ gridTemplateColumns: '320px 1fr' }}>
      <SessionList />
      <TranscriptView />
    </div>
  );
}
