import { useState, useEffect } from 'react';
import {
  ArrowLeft,
  Crosshair,
  Trash2,
  ClipboardCopy,
  ChevronDown,
  ChevronRight
} from 'lucide-react';
import { useAnnotationStore } from '../store/annotation-store';
import { openAnnotateModal } from '../lib/annotate-modal-bridge';
import { useToastStore } from '../store/toast-store';
import { toFleetImageUrl } from '../../../shared/path-platform';

function timeAgo(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

type AnnotationDetail = Awaited<
  ReturnType<ReturnType<typeof useAnnotationStore.getState>['getDetail']>
>;

export function AnnotateTab(): React.JSX.Element {
  const { annotations, isLoaded, loadAnnotations, getDetail, deleteAnnotation } =
    useAnnotationStore();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<AnnotationDetail>(null);
  const [expandedElements, setExpandedElements] = useState<Set<number>>(new Set());
  const showToast = useToastStore((s) => s.show);

  useEffect(() => {
    void loadAnnotations();
    const unsub = window.fleet.annotate.onCompleted(() => {
      void loadAnnotations();
    });
    return unsub;
  }, [loadAnnotations]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    void getDetail(selectedId).then(setDetail);
  }, [selectedId, getDetail]);

  const handleCopyPath = (id: string): void => {
    const meta = annotations.find((a) => a.id === id);
    if (!meta) return;
    void navigator.clipboard.writeText(meta.dirPath);
    showToast('Path copied to clipboard');
  };

  const toggleElement = (index: number): void => {
    setExpandedElements((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  // ── Detail View ──
  if (selectedId && detail) {
    return (
      <div className="h-full flex flex-col bg-fleet-surface text-fleet-text">
        {/* Header */}
        <div className="flex items-center gap-2 px-3 py-2 border-b border-fleet-border">
          <button
            onClick={() => setSelectedId(null)}
            className="p-1 text-fleet-text-muted hover:text-fleet-text rounded hover:bg-fleet-surface-2 transition active:scale-90"
          >
            <ArrowLeft size={16} />
          </button>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium truncate">{detail.url ?? 'Unknown URL'}</div>
            <div className="text-xs text-fleet-text-subtle">
              {detail.elements?.length ?? 0} elements
              {detail.viewport && ` \u00b7 ${detail.viewport.width}\u00d7${detail.viewport.height}`}
            </div>
          </div>
          <button
            onClick={() => handleCopyPath(selectedId)}
            className="p-1 text-fleet-text-muted hover:text-fleet-text rounded hover:bg-fleet-surface-2 transition active:scale-90"
            title="Copy path"
          >
            <ClipboardCopy size={14} />
          </button>
          <button
            onClick={() => {
              void deleteAnnotation(selectedId);
              setSelectedId(null);
            }}
            className="p-1 text-fleet-text-muted hover:text-red-400 rounded hover:bg-fleet-surface-2 transition active:scale-90"
            title="Delete"
          >
            <Trash2 size={14} />
          </button>
        </div>

        {/* Context */}
        {detail.context && (
          <div className="px-3 py-2 border-b border-fleet-border">
            <div className="text-xs text-fleet-text-subtle mb-1">Context</div>
            <div className="text-sm text-fleet-text-secondary">{detail.context}</div>
          </div>
        )}

        {/* Drawing overlay screenshot */}
        {detail.drawingOverlayPath && (
          <div className="px-3 py-2 border-b border-fleet-border">
            <div className="text-xs text-fleet-text-subtle mb-1">Drawing</div>
            <img
              src={toFleetImageUrl(detail.drawingOverlayPath)}
              alt="Drawing overlay"
              className="rounded border border-fleet-border-strong max-w-full max-h-60 object-contain"
            />
          </div>
        )}

        {/* Elements */}
        <div className="flex-1 overflow-y-auto">
          {detail.elements?.map((el, i) => (
            <div key={i} className="border-b border-fleet-border">
              {/* Element header — always visible */}
              <button
                onClick={() => toggleElement(i)}
                className="w-full flex items-center gap-2 px-3 py-2 hover:bg-fleet-surface-2 text-left transition active:scale-[0.97]"
              >
                <span className="flex-shrink-0 w-5 h-5 rounded-full fleet-accent-bg-soft fleet-accent-text text-xs flex items-center justify-center">
                  {i + 1}
                </span>
                {expandedElements.has(i) ? (
                  <ChevronDown size={12} className="text-fleet-text-subtle" />
                ) : (
                  <ChevronRight size={12} className="text-fleet-text-subtle" />
                )}
                <code className="text-xs text-fleet-text-secondary truncate flex-1">
                  {el.selector}
                </code>
                <span className="text-xs text-fleet-text-subtle">{el.tag}</span>
              </button>

              {/* Expanded detail */}
              {expandedElements.has(i) && (
                <div className="px-3 pb-3 pl-10 space-y-1.5">
                  {el.comment && (
                    <div className="text-sm text-amber-300">&ldquo;{el.comment}&rdquo;</div>
                  )}
                  {el.text && (
                    <div className="text-xs text-fleet-text-muted">
                      Text: <span className="text-fleet-text-secondary">{el.text}</span>
                    </div>
                  )}
                  {el.boxModel && (
                    <div className="text-xs text-fleet-text-muted">
                      Box: {el.rect.width}&times;{el.rect.height}
                      {' (pad: '}
                      {el.boxModel.padding.top} {el.boxModel.padding.right}{' '}
                      {el.boxModel.padding.bottom} {el.boxModel.padding.left})
                    </div>
                  )}
                  {el.accessibility && (
                    <div className="text-xs text-fleet-text-muted">
                      A11y: role={el.accessibility.role ?? 'none'}
                      {el.accessibility.name && ` name="${el.accessibility.name}"`}
                      {el.accessibility.focusable && ' focusable'}
                    </div>
                  )}
                  {el.keyStyles && Object.keys(el.keyStyles).length > 0 && (
                    <div className="text-xs text-fleet-text-muted">
                      Styles:{' '}
                      {Object.entries(el.keyStyles)
                        .map(([k, v]) => `${k}: ${v}`)
                        .join(', ')}
                    </div>
                  )}
                  {el.screenshotPath && (
                    <img
                      src={toFleetImageUrl(el.screenshotPath)}
                      alt={`Element ${i + 1}`}
                      className="mt-1 rounded border border-fleet-border-strong max-w-full max-h-40 object-contain"
                    />
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    );
  }

  // ── List View ──
  return (
    <div className="h-full flex flex-col bg-fleet-surface text-fleet-text">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-fleet-border">
        <div className="flex items-center gap-2">
          <Crosshair size={16} className="fleet-accent-text" />
          <span className="text-sm font-medium">Annotations</span>
        </div>
        <button
          onClick={() => openAnnotateModal()}
          className="px-2.5 py-1 text-xs fleet-accent-bg fleet-accent-bg-hover text-white rounded-md transition active:scale-[0.97]"
        >
          New
        </button>
      </div>

      {/* List or empty state */}
      {!isLoaded ? (
        <div className="flex-1 flex items-center justify-center text-fleet-text-subtle text-sm">
          Loading...
        </div>
      ) : annotations.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-3 text-fleet-text-subtle">
          <Crosshair size={32} className="text-fleet-text-subtle" />
          <p className="text-sm">No annotations yet</p>
          <button
            onClick={() => openAnnotateModal()}
            className="px-3 py-1.5 text-xs fleet-accent-bg fleet-accent-bg-hover text-white rounded-md transition active:scale-[0.97]"
          >
            New Annotation
          </button>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto">
          {annotations.map((ann) => (
            <div
              key={ann.id}
              role="button"
              tabIndex={0}
              className="w-full flex items-center gap-2 px-3 py-2.5 hover:bg-fleet-surface-2 border-b border-fleet-border/50 cursor-pointer"
              onClick={() => setSelectedId(ann.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  setSelectedId(ann.id);
                }
              }}
            >
              <div className="flex-1 min-w-0 text-left">
                <div className="text-sm text-fleet-text truncate">{ann.url}</div>
                <div className="text-xs text-fleet-text-subtle">
                  {timeAgo(ann.timestamp)} &middot; {ann.elementCount} element
                  {ann.elementCount !== 1 ? 's' : ''}
                </div>
              </div>
              <div className="flex items-center gap-1 flex-shrink-0">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    handleCopyPath(ann.id);
                  }}
                  className="p-1 text-fleet-text-muted hover:text-fleet-text rounded hover:bg-fleet-surface-2 transition active:scale-90"
                  title="Copy path"
                >
                  <ClipboardCopy size={14} />
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    void deleteAnnotation(ann.id);
                    if (selectedId === ann.id) setSelectedId(null);
                  }}
                  className="p-1 text-fleet-text-muted hover:text-red-400 rounded hover:bg-fleet-surface-2 transition active:scale-90"
                  title="Delete"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
