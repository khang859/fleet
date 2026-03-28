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
    window.copilot.getSessions().then(setSessions);
    loadSettings();
    const cleanup = window.copilot.onSessions(setSessions);
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
      <SpaceshipSprite />
      {expanded && (
        <div
          className="absolute top-[52px] right-0 w-[350px] h-[450px]"
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
