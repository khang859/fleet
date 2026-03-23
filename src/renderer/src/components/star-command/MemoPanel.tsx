import { useState, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { MemoInfo } from '../../store/star-command-store';

type MemoPanelProps = {
  onClose: () => void;
};

export function MemoPanel({ onClose }: MemoPanelProps): React.JSX.Element {
  const [memos, setMemos] = useState<MemoInfo[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [content, setContent] = useState<string | null>(null);

  useEffect(() => {
    void loadMemos();
  }, []);

  async function loadMemos(): Promise<void> {
    const list = await window.fleet.starbase.memoList();
    setMemos(list);
    if (list.length > 0 && !selectedId) {
      void selectMemo(list[0]);
    }
  }

  async function selectMemo(memo: MemoInfo): Promise<void> {
    setSelectedId(memo.id);
    const text = await window.fleet.starbase.memoContent(memo.file_path);
    setContent(text);
    if (memo.status === 'unread') {
      await window.fleet.starbase.memoRead(memo.id);
      void loadMemos();
    }
  }

  async function dismissMemo(id: number): Promise<void> {
    await window.fleet.starbase.memoDismiss(id);
    void loadMemos();
    if (selectedId === id) {
      setSelectedId(null);
      setContent(null);
    }
  }

  const activeMemos = memos;

  return (
    <div className="flex flex-col h-full bg-neutral-900">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-neutral-800">
        <h2 className="text-sm font-mono text-teal-400 uppercase tracking-widest">
          First Officer Memos
        </h2>
        <button onClick={onClose} className="text-neutral-500 hover:text-neutral-300 text-sm">
          Close
        </button>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* Memo list */}
        <div className="w-64 border-r border-neutral-800 overflow-y-auto">
          {activeMemos.length === 0 ? (
            <div className="p-4 text-xs text-neutral-500">No memos</div>
          ) : (
            activeMemos.map((memo) => (
              <button
                key={memo.id}
                onClick={() => {
                  void selectMemo(memo);
                }}
                className={`w-full text-left px-3 py-2 border-b border-neutral-800 hover:bg-neutral-800 transition-colors ${
                  selectedId === memo.id ? 'bg-neutral-800' : ''
                }`}
              >
                <div className="flex items-center gap-2">
                  {memo.status === 'unread' && (
                    <span className="w-2 h-2 rounded-full bg-amber-500 flex-shrink-0" />
                  )}
                  <span className="text-xs text-neutral-300 truncate">
                    {memo.summary || memo.event_type}
                  </span>
                </div>
                <div className="text-[10px] text-neutral-600 mt-0.5">
                  {memo.crew_id} · {new Date(memo.created_at).toLocaleTimeString()}
                </div>
              </button>
            ))
          )}
        </div>

        {/* Memo content */}
        <div className="flex-1 overflow-y-auto p-6">
          {content ? (
            <div className="prose prose-invert prose-sm max-w-none">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                  a: ({ href, children }) => (
                    <a
                      href={href}
                      onClick={(e) => {
                        e.preventDefault();
                        if (href) void window.fleet.shell.openExternal(href);
                      }}
                    >
                      {children}
                    </a>
                  )
                }}
              >
                {content}
              </ReactMarkdown>
            </div>
          ) : (
            <div className="text-xs text-neutral-500">Select a memo to read</div>
          )}

          {selectedId && (
            <div className="mt-4 pt-4 border-t border-neutral-800">
              <button
                onClick={() => {
                  void dismissMemo(selectedId);
                }}
                className="text-xs text-neutral-500 hover:text-neutral-300 px-3 py-1 rounded border border-neutral-700 hover:border-neutral-600 transition-colors"
              >
                Dismiss
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
