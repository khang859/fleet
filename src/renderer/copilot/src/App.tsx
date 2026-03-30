import { useEffect, useState, useCallback } from 'react';
import './index.css';
import { useCopilotStore } from './store/copilot-store';
import { SpaceshipSprite } from './components/SpaceshipSprite';
import { SessionList } from './components/SessionList';
import { SessionDetail } from './components/SessionDetail';
import { CopilotSettings } from './components/CopilotSettings';
import { MascotPicker } from './components/MascotPicker';
import { CrtFrame } from './components/CrtFrame';

type TeleportPhase = 'idle' | 'flash-out' | 'transitioning' | 'flash-in';

const TELEPORT_FLASH_MS = 200;

export function App(): React.JSX.Element {
  const expanded = useCopilotStore((s) => s.expanded);
  const view = useCopilotStore((s) => s.view);
  const setSessions = useCopilotStore((s) => s.setSessions);
  const loadSettings = useCopilotStore((s) => s.loadSettings);
  const setExpanded = useCopilotStore((s) => s.setExpanded);

  // Teleport animation state machine
  const [teleportPhase, setTeleportPhase] = useState<TeleportPhase>('idle');
  const [showPane, setShowPane] = useState(false);

  // Track the previous expanded state to detect transitions
  const [prevExpanded, setPrevExpanded] = useState(false);

  useEffect(() => {
    if (expanded === prevExpanded) return;
    setPrevExpanded(expanded);

    if (expanded) {
      // Expanding: flash out floating mascot → show pane → flash in header mascot
      setTeleportPhase('flash-out');
      setTimeout(() => {
        setShowPane(true);
        setTeleportPhase('flash-in');
        setTimeout(() => {
          setTeleportPhase('idle');
        }, TELEPORT_FLASH_MS);
      }, TELEPORT_FLASH_MS);
    } else {
      // Collapsing: flash out header mascot → hide pane → flash in floating mascot
      setTeleportPhase('flash-out');
      setTimeout(() => {
        setShowPane(false);
        setTeleportPhase('flash-in');
        setTimeout(() => {
          setTeleportPhase('idle');
        }, TELEPORT_FLASH_MS);
      }, TELEPORT_FLASH_MS);
    }
  }, [expanded, prevExpanded]);

  const handleClose = useCallback(() => {
    window.copilot.setExpanded(false);
  }, []);

  // IPC subscriptions
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

  // Escape key to close
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && expanded) {
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

  // Determine teleport visual state for the sprite
  const spriteTeleportState = teleportPhase === 'flash-out' || teleportPhase === 'flash-in'
    ? (teleportPhase === 'flash-out' ? 'out' : 'in')
    : 'idle';

  return (
    <div className="relative w-full h-full">
      {/* Floating mascot — visible when pane is NOT shown */}
      {!showPane && (
        <div className="flex justify-end">
          <SpaceshipSprite
            mode="floating"
            teleportState={spriteTeleportState}
          />
        </div>
      )}

      {/* Centered pane with backdrop — visible when pane IS shown */}
      {showPane && (
        <div className="fixed inset-0" onClick={handleClose}>
          {/* Backdrop layer — separate div for future sci-fi assets */}
          <div className="absolute inset-0 bg-black/60" />
          {/* Pane centering layer */}
          <div className="absolute inset-0 flex items-center justify-center">
          <div
            className="flex flex-col"
            style={{ width: 600, height: 500 }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Pane header with mascot */}
            <div className="flex items-center gap-3 px-4 py-2 shrink-0">
              <SpaceshipSprite
                mode="header"
                teleportState={spriteTeleportState}
              />
              <span className="text-white text-sm font-medium tracking-wide opacity-70">
                Fleet Copilot
              </span>
            </div>

            {/* Pane body */}
            <div className="flex-1 min-h-0">
              <CrtFrame>
                {view === 'sessions' && <SessionList />}
                {view === 'detail' && <SessionDetail />}
                {view === 'settings' && <CopilotSettings />}
                {view === 'mascots' && <MascotPicker />}
              </CrtFrame>
            </div>
          </div>
          </div>
        </div>
      )}
    </div>
  );
}
