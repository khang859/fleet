import { useEffect, useRef, useState } from 'react';
import { useChatStore } from '../../store/chat-store';
import { usePresence } from '../../hooks/use-presence';
import { useReducedMotion } from '../../hooks/use-reduced-motion';
import { permissionView } from './permission-queue';
import { ToolCallCard } from './ToolCallCard';
import type {
  PermissionOutcome,
  PermissionRequestPayload
} from '../../../../shared/chat-permissions';

const LINGER_MS = 700;

/**
 * Pending tool-call approvals, pinned as an overlay just above the composer
 * instead of inline in the scroll stream. Shows one request at a time with a
 * "+N more" peek and an "Allow all" batch action; a decided last card lingers
 * briefly (showing Allowed/Denied) then the bar fades out. All timing is local
 * so it can't race the turn-end store reset.
 */
type Props = { hostRef: React.RefObject<HTMLDivElement | null> };

export function PermissionBar({ hostRef }: Props): React.JSX.Element | null {
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
    const t = setTimeout(
      () => {
        setRenderId(null);
        setPeekOpen(false);
      },
      reduced ? 0 : LINGER_MS
    );
    return () => clearTimeout(t);
  }, [targetId, renderId, reduced]);

  const lastShownRef = useRef<PermissionRequestPayload | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const shown = renderId
    ? (permissionRequests.find((r) => r.requestId === renderId) ?? null)
    : null;
  if (shown) lastShownRef.current = shown;
  const { mounted, state } = usePresence(shown !== null, reduced ? 0 : 150);

  const [peekOpen, setPeekOpen] = useState(false);

  // Keyboard: Alt+Enter allows the active card. Deny stays button-only - a global
  // deny shortcut on Alt+Backspace collides with macOS Option+Delete (delete word)
  // and could silently deny while the user edits the composer.
  useEffect(() => {
    const active = view.active;
    if (!active) return;
    const onKey = (e: KeyboardEvent): void => {
      if (!e.altKey) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        void decidePermission(active.requestId, 'allow-once');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [view.active, decidePermission]);

  // Publish the bar's live height to the shared overlay host as a CSS var so the
  // sibling "Jump to latest" pill can lift itself clear of the bar. Keyed to the
  // bar's mounted lifecycle (through the linger + fade), so the pill stays raised
  // until the bar is actually gone. Writing a custom property recalcs style only
  // for the elements reading it - no React re-render, no layout thrash.
  useEffect(() => {
    const host = hostRef.current;
    const card = cardRef.current;
    if (!mounted || !host || !card) return;
    const ro = new ResizeObserver(() => {
      host.style.setProperty('--permission-bar-h', `${card.offsetHeight + 8}px`); // +8 = pb-2
    });
    ro.observe(card);
    return () => {
      ro.disconnect();
      host.style.removeProperty('--permission-bar-h');
    };
  }, [mounted, hostRef]);

  if (!mounted) return null;
  const display = shown ?? lastShownRef.current;
  if (!display) return null;

  const decided: PermissionOutcome | null = decidedRequests[display.requestId] ?? null;

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 px-4 pb-2">
      <div
        ref={cardRef}
        role="region"
        aria-label="Pending tool approval"
        aria-live="polite"
        className={`mx-auto w-full max-w-3xl rounded-lg border border-fleet-border bg-fleet-surface-1 shadow-lg transition-all duration-150 ${
          state === 'open'
            ? 'pointer-events-auto translate-y-0 opacity-100'
            : 'pointer-events-none translate-y-1 opacity-0'
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
          key={display.requestId}
          request={display}
          decided={decided}
          onDecide={(outcome) => void decidePermission(display.requestId, outcome)}
        />
      </div>
    </div>
  );
}
