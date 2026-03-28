import { useEffect } from 'react';
import './index.css';
import { useCopilotStore } from './store/copilot-store';
import { SpaceshipSprite } from './components/SpaceshipSprite';
import { SessionList } from './components/SessionList';
import { SessionDetail } from './components/SessionDetail';
import { CopilotSettings } from './components/CopilotSettings';

export function App(): React.JSX.Element {
  const expanded = useCopilotStore((s) => s.expanded);
  const panelDirection = useCopilotStore((s) => s.panelDirection);
  const view = useCopilotStore((s) => s.view);
  const setSessions = useCopilotStore((s) => s.setSessions);
  const loadSettings = useCopilotStore((s) => s.loadSettings);
  const setExpanded = useCopilotStore((s) => s.setExpanded);

  useEffect(() => {
    if (!window.copilot) return;
    window.copilot.getSessions().then(setSessions).catch(() => {});
    loadSettings().catch(() => {});
    const cleanupSessions = window.copilot.onSessions(setSessions);
    const cleanupExpanded = window.copilot.onExpandedChanged(setExpanded);
    return () => {
      cleanupSessions();
      cleanupExpanded();
    };
  }, [setSessions, loadSettings, setExpanded]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && expanded) {
        // Escape is an explicit user action, send directly to main
        window.copilot.setExpanded(false);
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [expanded]);

  // Subscribe to real-time chat updates
  useEffect(() => {
    if (!window.copilot) return;
    const setChatMessages = useCopilotStore.getState().setChatMessages;
    const unsub = window.copilot.onChatUpdated(({ sessionId, messages }) => {
      setChatMessages(sessionId, messages);
    });
    return unsub;
  }, []);

  return (
    <div className="relative w-full h-full">
      <div className={`flex ${
        expanded && panelDirection?.horizontal === 'right' ? 'justify-start' : 'justify-end'
      } ${
        expanded && panelDirection?.vertical === 'up' ? 'absolute bottom-0 right-0 left-0' : ''
      }`}>
        <SpaceshipSprite />
      </div>
      {expanded && (
        <div
          className={`absolute right-0 left-0 h-[450px] ${
            panelDirection?.vertical === 'up' ? 'bottom-[132px]' : 'top-[132px]'
          }`}
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
