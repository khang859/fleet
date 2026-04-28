import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ExternalLink, X } from 'lucide-react';
import { MarkdownPane } from './MarkdownPane';
import { useWorkspaceStore } from '../store/workspace-store';
import { getPaneTypeForFilePath } from '../../../shared/file-open';
import type { PiPlanAction, PiPlanOpenPayload } from '../../../shared/ipc-api';

type PiPlanModalProps = {
  plan: PiPlanOpenPayload | null;
  contentKey?: string;
  onClose: () => void;
};

export function PiPlanModal({
  plan,
  contentKey,
  onClose
}: PiPlanModalProps): React.JSX.Element | null {
  const modalRef = useRef<HTMLDivElement>(null);
  const paneIdRef = useRef(`pi-plan-modal-${crypto.randomUUID()}`);
  const [feedback, setFeedback] = useState('');
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submittingAction, setSubmittingAction] = useState<PiPlanAction | null>(null);
  const openFileInTab = useWorkspaceStore((s) => s.openFileInTab);

  const filePath = plan?.path ?? null;
  const canRespond = Boolean(plan?.paneId && plan.requestId);

  useEffect(() => {
    if (!filePath) return;
    setFeedback('');
    setSubmitError(null);
    setSubmittingAction(null);
    modalRef.current?.focus();
  }, [filePath, plan?.requestId]);

  const respond = useCallback(
    async (action: PiPlanAction) => {
      if (!plan?.paneId || !plan.requestId) {
        onClose();
        return;
      }

      setSubmittingAction(action);
      setSubmitError(null);
      try {
        await window.fleet.pi.respondToPlan({
          paneId: plan.paneId,
          requestId: plan.requestId,
          action,
          feedback: feedback.trim() || undefined
        });
        onClose();
      } catch (err) {
        setSubmitError(err instanceof Error ? err.message : String(err));
      } finally {
        setSubmittingAction(null);
      }
    },
    [feedback, onClose, plan?.paneId, plan?.requestId]
  );

  const closeOrContinue = useCallback(() => {
    if (canRespond && !submitError) {
      void respond('continue');
      return;
    }
    onClose();
  }, [canRespond, onClose, respond, submitError]);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      closeOrContinue();
    },
    [closeOrContinue]
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

  const footerHint = useMemo(() => {
    if (!canRespond) return 'Opened from Fleet CLI. This modal is read-only.';
    return 'Approve exits plan mode. Reject or Continue keeps Pi in plan mode with your feedback.';
  }, [canRespond]);

  if (!filePath) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
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
              onClick={closeOrContinue}
              className="p-1 text-neutral-500 hover:text-white rounded hover:bg-neutral-800 transition-colors"
              aria-label="Close plan modal"
            >
              <X size={16} />
            </button>
          </div>
        </div>
        <div className="flex-1 min-h-0 overflow-hidden">
          <MarkdownPane
            key={`${filePath}:${plan?.requestId ?? contentKey ?? ''}`}
            paneId={paneIdRef.current}
            filePath={filePath}
          />
        </div>
        <div className="shrink-0 border-t border-neutral-800 bg-neutral-950/90 p-3 space-y-2">
          <div className="text-xs text-neutral-500">{footerHint}</div>
          {canRespond && (
            <>
              {submitError && (
                <div className="flex items-center justify-between gap-3 rounded border border-red-900/60 bg-red-950/30 px-2 py-1.5 text-xs text-red-300">
                  <span>{submitError}</span>
                  <button
                    onClick={onClose}
                    className="shrink-0 rounded px-2 py-0.5 text-red-200 hover:bg-red-900/40"
                  >
                    Dismiss
                  </button>
                </div>
              )}
              <textarea
                value={feedback}
                onChange={(event) => setFeedback(event.target.value)}
                placeholder="Optional feedback for Pi..."
                className="w-full h-16 resize-none rounded border border-neutral-700 bg-neutral-900 px-2 py-1.5 text-sm text-neutral-200 placeholder-neutral-600 outline-none focus:border-teal-500"
              />
              <div className="flex justify-end gap-2">
                <button
                  onClick={() => void respond('reject')}
                  disabled={submittingAction !== null}
                  className="px-3 py-1.5 text-sm rounded border border-red-900/60 text-red-300 hover:bg-red-950/40 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {submittingAction === 'reject' ? 'Rejecting…' : 'Reject'}
                </button>
                <button
                  onClick={() => void respond('continue')}
                  disabled={submittingAction !== null}
                  className="px-3 py-1.5 text-sm rounded border border-neutral-700 text-neutral-300 hover:bg-neutral-800 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {submittingAction === 'continue' ? 'Sending…' : 'Continue planning'}
                </button>
                <button
                  onClick={() => void respond('approve')}
                  disabled={submittingAction !== null}
                  className="px-3 py-1.5 text-sm rounded bg-teal-600 text-white hover:bg-teal-500 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {submittingAction === 'approve' ? 'Approving…' : 'Approve'}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
