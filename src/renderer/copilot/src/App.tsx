import { useEffect } from 'react';
import './index.css';
import { useCopilotStore } from './store/copilot-store';
import { SpaceshipSprite } from './components/SpaceshipSprite';
import { SessionList } from './components/SessionList';
import { SessionDetail } from './components/SessionDetail';
import { CopilotSettings } from './components/CopilotSettings';

export function App(): React.JSX.Element {
  const expanded = useCopilotStore((s) => s.expanded);
  const view = useCopilotStore((s) => s.view);
  const setSessions = useCopilotStore((s) => s.setSessions);
  const loadSettings = useCopilotStore((s) => s.loadSettings);
  const setExpanded = useCopilotStore((s) => s.setExpanded);

  useEffect(() => {
    if (!window.copilot) {
      console.error('[copilot] window.copilot is undefined — preload failed');
      return;
    }
    console.log('[copilot] initializing, fetching sessions...');
    window.copilot.getSessions().then((sessions) => {
      console.log('[copilot] got sessions:', sessions.length);
      setSessions(sessions);
    }).catch((err) => {
      console.error('[copilot] getSessions failed:', err);
    });
    loadSettings().catch((err) => {
      console.error('[copilot] loadSettings failed:', err);
    });
    const cleanup = window.copilot.onSessions((sessions) => {
      console.log('[copilot] sessions update:', sessions.length);
      setSessions(sessions);
    });
    return cleanup;
  }, [setSessions, loadSettings]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && expanded) {
        setExpanded(false);
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [expanded, setExpanded]);

  return (
    <div className="relative">
      <div className="flex justify-end">
        <SpaceshipSprite />
      </div>
      {expanded && (
        <div
          className="absolute top-[52px] right-0 left-0 h-[450px]"
          style={{ zIndex: 10 }}
        >
          {view === 'sessions' && <SessionList />}
          {view === 'detail' && <SessionDetail />}
          {view === 'settings' && <CopilotSettings />}
        </div>
      )}
    </div>
  );
}
