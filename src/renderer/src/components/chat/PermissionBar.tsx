import { useEffect, useState } from 'react';
import { useChatStore } from '../../store/chat-store';
import { usePresence } from '../../hooks/use-presence';
import { useReducedMotion } from '../../hooks/use-reduced-motion';
import { permissionView } from './permission-queue';
import { ToolCallCard } from './ToolCallCard';
import type { PermissionOutcome } from '../../../../shared/chat-permissions';

const LINGER_MS = 700;

/**
 * Pending tool-call approvals, pinned as an overlay just above the composer
 * instead of inline in the scroll stream. Shows one request at a time with a
 * "+N more" peek and an "Allow all" batch action; a decided last card lingers
 * briefly (showing Allowed/Denied) then the bar fades out. All timing is local
 * so it can't race the turn-end store reset.
 */
export function PermissionBar(): React.JSX.Element | null {
  const permissionRequests = useChatStore((s) => s.permissionRequests);
  const decidedRequests = useChatStore((s) => s.decidedRequests);
  const decidePermission = useChatStore((s) => s.decidePermission);
  const allowAllPermissions = useChatStore((s) => s.allowAllPermissions);
  const reduced = useReducedMotion();

  const view = permissionView(permissionRequests, decidedRequests);
  const targetId = view.active?.requestId ?? null;

  // The request currently on screen. Advances to the next pending request
  // immediately; when nothing is pending it lingers on the last decided card
  // for LINGER_MS so its confirmation is visible before the bar fades out.
  const [renderId, setRenderId] = useState<string | null>(targetId);
  useEffect(() => {
    if (targetId) {
      setRenderId(targetId);
      return;
    }
    if (renderId === null) return;
    const t = setTimeout(() => setRenderId(null), reduced ? 0 : LINGER_MS);
    return () => clearTimeout(t);
  }, [targetId, renderId, reduced]);

  const shown = renderId
    ? (permissionRequests.find((r) => r.requestId === renderId) ?? null)
    : null;
  const { mounted, state } = usePresence(shown !== null, reduced ? 0 : 150);

  const [peekOpen, setPeekOpen] = useState(false);

  // Keyboard: Alt+Enter allows, Alt+Backspace denies the active card, regardless
  // of composer focus. Modifier-based so plain typing is never intercepted.
  useEffect(() => {
    const active = view.active;
    if (!active) return;
    const onKey = (e: KeyboardEvent): void => {
      if (!e.altKey) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        void decidePermission(active.requestId, 'allow-once');
      } else if (e.key === 'Backspace' || e.key === 'Delete') {
        e.preventDefault();
        void decidePermission(active.requestId, 'deny');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [view.active, decidePermission]);

  if (!mounted || !shown) return null;

  const decided: PermissionOutcome | null = decidedRequests[shown.requestId] ?? null;

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 px-4 pb-2">
      <div
        role="region"
        aria-label="Pending tool approval"
        aria-live="polite"
        className={`pointer-events-auto mx-auto w-full max-w-3xl rounded-lg border border-fleet-border bg-fleet-surface-1 shadow-lg transition-all duration-150 ${
          state === 'open' ? 'translate-y-0 opacity-100' : 'translate-y-1 opacity-0'
        }`}
      >
        {view.more > 0 && (
          <div className="flex items-center justify-between gap-2 border-b border-fleet-border px-3 py-1.5 text-xs text-fleet-text-muted">
            <button
              type="button"
              onClick={() => setPeekOpen((v) => !v)}
              aria-expanded={peekOpen}
              className="focus-ring rounded hover:text-fleet-text"
            >
              +{view.more} more pending
            </button>
            <button
              type="button"
              onClick={() => allowAllPermissions()}
              className="rounded bg-fleet-surface-3 px-2 py-0.5 text-fleet-text hover:bg-fleet-surface-2"
            >
              Allow all {view.undecidedCount}
            </button>
          </div>
        )}
        {peekOpen && view.more > 0 && (
          <ul className="max-h-32 space-y-1 overflow-auto border-b border-fleet-border px-3 py-2 text-xs">
            {view.queued.map((r) => (
              <li key={r.requestId} className="flex gap-2 text-fleet-text-secondary">
                <span className="shrink-0 font-medium text-fleet-text">{r.tool}</span>
                <code className="min-w-0 flex-1 truncate font-mono text-fleet-text-muted">
                  {r.command}
                </code>
              </li>
            ))}
          </ul>
        )}
        <ToolCallCard
          key={shown.requestId}
          request={shown}
          decided={decided}
          onDecide={(outcome) => void decidePermission(shown.requestId, outcome)}
        />
      </div>
    </div>
  );
}
