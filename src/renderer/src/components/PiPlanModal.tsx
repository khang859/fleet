import { useCallback, useEffect, useRef } from 'react';
import { ExternalLink, X } from 'lucide-react';
import { MarkdownPane } from './MarkdownPane';
import { useWorkspaceStore } from '../store/workspace-store';
import { getPaneTypeForFilePath } from '../../../shared/file-open';

type PiPlanModalProps = {
  filePath: string | null;
  onClose: () => void;
};

export function PiPlanModal({ filePath, onClose }: PiPlanModalProps): React.JSX.Element | null {
  const modalRef = useRef<HTMLDivElement>(null);
  const paneIdRef = useRef(`pi-plan-modal-${crypto.randomUUID()}`);
  const openFileInTab = useWorkspaceStore((s) => s.openFileInTab);

  useEffect(() => {
    if (!filePath) return;
    modalRef.current?.focus();
  }, [filePath]);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    },
    [onClose]
  );

  const handleOpenInTab = useCallback(() => {
    if (!filePath) return;
    openFileInTab([
      {
        path: filePath,
        paneType: getPaneTypeForFilePath(filePath),
        label: filePath.split('/').pop() ?? filePath
      }
    ]);
  }, [filePath, openFileInTab]);

  if (!filePath) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onMouseDown={onClose}
    >
      <div
        ref={modalRef}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
        onMouseDown={(event) => event.stopPropagation()}
        className="bg-neutral-900 border border-neutral-700 rounded-lg shadow-xl flex flex-col outline-none overflow-hidden"
        style={{ width: 'calc(100vw - 64px)', height: 'calc(100vh - 48px)' }}
      >
        <div className="flex items-center justify-between px-4 py-2 border-b border-neutral-800 shrink-0 bg-neutral-950/90">
          <div className="min-w-0">
            <div className="text-sm font-medium text-white">Pi Plan</div>
            <div className="text-xs text-neutral-500 font-mono truncate" title={filePath}>
              {filePath}
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={handleOpenInTab}
              className="inline-flex items-center gap-1.5 px-2 py-1 text-xs text-neutral-400 hover:text-white rounded hover:bg-neutral-800 transition-colors"
            >
              <ExternalLink size={14} />
              Open as tab
            </button>
            <button
              onClick={onClose}
              className="p-1 text-neutral-500 hover:text-white rounded hover:bg-neutral-800 transition-colors"
              aria-label="Close plan modal"
            >
              <X size={16} />
            </button>
          </div>
        </div>
        <div className="flex-1 min-h-0 overflow-hidden">
          <MarkdownPane key={filePath} paneId={paneIdRef.current} filePath={filePath} />
        </div>
      </div>
    </div>
  );
}
