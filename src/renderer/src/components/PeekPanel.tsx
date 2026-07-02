import { useState, useEffect, useRef } from 'react';
import { useWorkspaceStore } from '../store/workspace-store';
import { useNotificationStore } from '../store/notification-store';
import { findPaneLocation, paneLabel } from '../lib/palette-items';
import { getPaneTailText } from '../hooks/use-terminal';
import { bracketedPaste } from '../lib/shell-utils';
import { Overlay } from './Overlay';
import { PaneStatusGlyph } from './PaneStatusGlyph';

type PeekPanelProps = {
  paneId: string | null;
  onClose: () => void;
};

const TAIL_LINES = 40;
const REFRESH_MS = 1000;

/**
 * Glance at a non-focused pane's recent output and send it a reply, without
 * switching tabs/panes or stealing focus from whatever the user is doing.
 */
export function PeekPanel({ paneId, onClose }: PeekPanelProps): React.JSX.Element | null {
  const [tail, setTail] = useState('');
  const [reply, setReply] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const isOpen = paneId !== null;

  const tabs = useWorkspaceStore((s) => s.workspace.tabs);
  const activity = useNotificationStore((s) => (paneId ? s.getActivity(paneId) : undefined));

  const loc = paneId ? findPaneLocation(tabs, paneId) : null;
  const label = loc ? paneLabel(loc) : '';

  useEffect(() => {
    setReply('');
    if (!paneId) return;
    const update = (): void => setTail(getPaneTailText(paneId, TAIL_LINES) ?? '');
    update();
    const interval = setInterval(update, REFRESH_MS);
    return () => clearInterval(interval);
  }, [paneId]);

  useEffect(() => {
    if (isOpen) requestAnimationFrame(() => inputRef.current?.focus());
  }, [isOpen]);

  const handleSend = (): void => {
    if (!paneId || !reply.trim()) return;
    window.fleet.pty.input({ paneId, data: bracketedPaste(reply) + '\r' });
    setReply('');
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <Overlay
      open={isOpen}
      onClose={onClose}
      containerClassName="justify-center"
      panelClassName="mt-[12vh] w-[560px] max-h-[70vh] flex flex-col bg-fleet-surface-2 border border-fleet-border-strong rounded-lg shadow-xl overflow-hidden"
    >
      <div className="px-3 py-2 border-b border-fleet-border flex items-center gap-2">
        {activity && <PaneStatusGlyph state={activity.state} className="shrink-0" />}
        <span className="flex-1 truncate text-xs font-medium text-fleet-text-secondary uppercase tracking-wide">
          {label || 'Pane'}
        </span>
      </div>
      <pre className="flex-1 min-h-[200px] overflow-y-auto px-3 py-2 text-xs font-mono leading-relaxed text-fleet-text-secondary whitespace-pre-wrap break-words">
        {tail || 'No output yet'}
      </pre>
      <div className="border-t border-fleet-border p-2 flex flex-col gap-1.5">
        <textarea
          ref={inputRef}
          value={reply}
          onChange={(e) => setReply(e.target.value)}
          onKeyDown={handleKeyDown}
          rows={2}
          placeholder="Reply without switching panes..."
          className="w-full resize-none rounded bg-fleet-surface-3 border border-fleet-border px-2 py-1.5 text-xs text-fleet-text placeholder:text-fleet-text-subtle outline-none focus:border-fleet-border-strong"
        />
        <div className="flex items-center justify-between text-[10px] text-fleet-text-subtle">
          <span>↵ send · shift+↵ newline · esc dismiss</span>
          <button
            onClick={handleSend}
            disabled={!reply.trim()}
            className="px-2 py-0.5 rounded bg-fleet-surface-3 hover:bg-fleet-border disabled:opacity-40 disabled:pointer-events-none text-fleet-text-secondary active:scale-[0.97]"
          >
            Send
          </button>
        </div>
      </div>
    </Overlay>
  );
}
