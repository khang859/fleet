import { useEffect, useState, useCallback, useRef } from 'react';
import './index.css';
import { useCopilotStore } from './store/copilot-store';
import { SpaceshipSprite } from './components/SpaceshipSprite';
import { SessionList } from './components/SessionList';
import { SessionDetail } from './components/SessionDetail';
import { CopilotSettings } from './components/CopilotSettings';
import { MascotPicker } from './components/MascotPicker';
import { CrtFrame } from './components/CrtFrame';

type TeleportPhase = 'idle' | 'flash-out' | 'flash-in';

const TELEPORT_FLASH_MS = 200;

export function App(): React.JSX.Element {
  const view = useCopilotStore((s) => s.view);
  const setSessions = useCopilotStore((s) => s.setSessions);
  const loadSettings = useCopilotStore((s) => s.loadSettings);
  const setExpanded = useCopilotStore((s) => s.setExpanded);

  const [teleportPhase, setTeleportPhase] = useState<TeleportPhase>('idle');
  const [showPane, setShowPane] = useState(false);
  const teleportingRef = useRef(false);

  // Animate transition: flash-out → resize window + swap view → flash-in
  const animateTransition = useCallback((willExpand: boolean) => {
    if (teleportingRef.current) return;
    teleportingRef.current = true;

    // Phase 1: flash-out the current sprite
    setTeleportPhase('flash-out');

    setTimeout(() => {
      // Phase 2: tell main to resize, swap the visible view
      window.copilot.setExpanded(willExpand);
      setExpanded(willExpand);
      setShowPane(willExpand);

      // Phase 3: flash-in the new sprite
      setTeleportPhase('flash-in');

      setTimeout(() => {
        setTeleportPhase('idle');
        teleportingRef.current = false;
      }, TELEPORT_FLASH_MS);
    }, TELEPORT_FLASH_MS);
  }, [setExpanded]);

  const handleToggle = useCallback(() => {
    animateTransition(!showPane);
  }, [showPane, animateTransition]);

  const handleClose = useCallback(() => {
    animateTransition(false);
  }, [animateTransition]);

  // IPC subscriptions
  useEffect(() => {
    if (!window.copilot) return;
    window.copilot.getSessions().then(setSessions).catch(() => {});
    loadSettings().catch(() => {});
    const cleanupSessions = window.copilot.onSessions(setSessions);
    const cleanupExpanded = window.copilot.onExpandedChanged((expanded) => {
      // Sync store state (resets view on collapse)
      setExpanded(expanded);
      // If not mid-animation, sync pane visibility for external triggers
      if (!teleportingRef.current) {
        setShowPane(expanded);
      }
    });
    return () => {
      cleanupSessions();
      cleanupExpanded();
    };
  }, [setSessions, loadSettings, setExpanded]);

  // Escape key to close
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && showPane) {
        animateTransition(false);
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [showPane, animateTransition]);

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
  const spriteTeleportState = teleportPhase === 'flash-out'
    ? 'out'
    : teleportPhase === 'flash-in'
      ? 'in'
      : 'idle';

  return (
    <div className="relative w-full h-full">
      {/* Floating mascot — visible when pane is NOT shown */}
      {!showPane && (
        <div className="flex justify-end">
          <SpaceshipSprite
            mode="floating"
            teleportState={spriteTeleportState}
            onToggle={handleToggle}
          />
        </div>
      )}

      {/* Centered pane with backdrop — visible when pane IS shown */}
      {showPane && (
        <div className="fixed inset-0" onClick={handleClose}>
          {/* Backdrop layer — separate div for future sci-fi assets */}
          <div className="absolute inset-0 bg-black/60" />
          {/* Pane centering layer */}
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            {/* Mascot — sized to its own content, not the pane width */}
            <div className="shrink-0 mb-2" onClick={(e) => e.stopPropagation()}>
              <SpaceshipSprite
                mode="header"
                teleportState={spriteTeleportState}
                onToggle={handleToggle}
              />
            </div>

            {/* Pane body */}
            <div
              style={{ width: 600, height: 500 }}
              onClick={(e) => e.stopPropagation()}
            >
              <CrtFrame>
                {view === 'sessions' && <SessionList />}
                {view === 'detail' && <SessionDetail />}
                {view === 'settings' && <CopilotSettings />}
                {view === 'mascots' && <MascotPicker />}
              </CrtFrame>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
