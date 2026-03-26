import { useState, useEffect, useRef, useCallback } from 'react';
import { Clipboard } from 'lucide-react';
import { useWorkspaceStore } from '../store/workspace-store';
import { useStarCommandStore } from '../store/star-command-store';
import { bracketedPaste } from '../lib/shell-utils';
import type { ClipboardEntry } from '../../../shared/ipc-api';

type ClipboardHistoryOverlayProps = {
  isOpen: boolean;
  onClose: () => void;
};

function formatTimestamp(epochMs: number): string {
  const diff = Date.now() - epochMs;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(epochMs).toLocaleTimeString();
}

function truncateLines(text: string, maxLines: number): string {
  const lines = text.split('\n');
  if (lines.length <= maxLines) return text;
  return lines.slice(0, maxLines).join('\n') + '\n...';
}

export function ClipboardHistoryOverlay({
  isOpen,
  onClose
}: ClipboardHistoryOverlayProps): React.JSX.Element | null {
  const [entries, setEntries] = useState<ClipboardEntry[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [filter, setFilter] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const activePaneId = useWorkspaceStore((s) => s.activePaneId);
  const admiralPaneId = useStarCommandStore((s) => s.admiralPaneId);
  const targetPaneId = activePaneId ?? admiralPaneId;

  // Load history and subscribe to changes
  useEffect(() => {
    if (!isOpen) return;

    setFilter('');
    setSelectedIndex(0);

    // Fetch current history
    void window.fleet.clipboard.getHistory().then((res) => {
      setEntries(res.entries);
    });

    // Subscribe to live updates
    const unsub = window.fleet.clipboard.onChanged((payload) => {
      setEntries(payload.entries);
    });

    requestAnimationFrame(() => inputRef.current?.focus());

    return unsub;
  }, [isOpen]);

  // Reset selection when entries or filter changes
  useEffect(() => {
    setSelectedIndex(0);
  }, [entries, filter]);

  // Scroll selected into view
  useEffect(() => {
    const child = listRef.current?.children[selectedIndex];
    if (child instanceof HTMLElement) child.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  const filtered = filter
    ? entries.filter((e) => e.text.toLowerCase().includes(filter.toLowerCase()))
    : entries;

  const handlePaste = useCallback(
    (entry: ClipboardEntry) => {
      if (!targetPaneId) return;
      window.fleet.pty.input({ paneId: targetPaneId, data: bracketedPaste(entry.text) });
      onClose();
      // Re-focus the target pane after overlay DOM unmounts
      requestAnimationFrame(() => {
        document.dispatchEvent(
          new CustomEvent('fleet:refocus-pane', { detail: { paneId: targetPaneId } })
        );
      });
    },
    [targetPaneId, onClose]
  );

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (selectedIndex < filtered.length) {
        handlePaste(filtered[selectedIndex]);
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex justify-center bg-black/60" onClick={onClose}>
      <div
        className="mt-[15vh] w-[560px] max-h-[60vh] flex flex-col bg-neutral-900 border border-neutral-700 rounded-lg shadow-xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-3 py-2 border-b border-neutral-800 flex items-center gap-2">
          <Clipboard size={14} className="text-neutral-500 shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Filter clipboard history..."
            className="flex-1 bg-transparent text-sm text-white outline-none placeholder-neutral-500"
          />
          <span className="text-[10px] text-neutral-600">{filtered.length} items</span>
        </div>

        {/* Entries list */}
        <div ref={listRef} className="overflow-y-auto py-1">
          {filtered.length === 0 ? (
            <div className="px-3 py-4 text-sm text-neutral-500 text-center">
              {entries.length === 0 ? 'Clipboard history is empty' : 'No matching entries'}
            </div>
          ) : (
            filtered.map((entry, i) => (
              <button
                key={entry.id}
                className={`w-full flex flex-col gap-0.5 px-3 py-2 text-left transition-colors ${
                  i === selectedIndex
                    ? 'bg-neutral-700 text-white'
                    : 'text-neutral-300 hover:bg-neutral-800'
                }`}
                onMouseEnter={() => setSelectedIndex(i)}
                onClick={() => handlePaste(entry)}
              >
                <pre className="text-sm font-mono whitespace-pre-wrap break-all line-clamp-3">
                  {truncateLines(entry.preview, 3)}
                </pre>
                <div className="flex items-center gap-2 text-[10px] text-neutral-600">
                  <span>{formatTimestamp(entry.timestamp)}</span>
                  <span>{entry.charCount} chars</span>
                  {entry.lineCount > 1 && <span>{entry.lineCount} lines</span>}
                </div>
              </button>
            ))
          )}
        </div>

        {/* Preview pane for selected entry */}
        {filtered[selectedIndex] && filtered[selectedIndex].text.length > 200 && (
          <div className="border-t border-neutral-800 px-3 py-2 max-h-[20vh] overflow-y-auto">
            <div className="text-[10px] text-neutral-600 uppercase tracking-wider mb-1">
              Preview
            </div>
            <pre className="text-xs font-mono text-neutral-400 whitespace-pre-wrap break-all">
              {filtered[selectedIndex].text}
            </pre>
          </div>
        )}

        {/* Footer */}
        <div className="px-3 py-1.5 border-t border-neutral-800 flex items-center gap-3 text-xs text-neutral-600">
          {!targetPaneId ? (
            <span className="text-amber-500/80">No active terminal</span>
          ) : (
            <>
              <span>↑↓ navigate</span>
              <span>↵ paste to terminal</span>
              <span>esc dismiss</span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
