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
import { AnnotateModal } from './AnnotateModal';
import { useToastStore } from '../store/toast-store';

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
  const {
    annotations,
    isLoaded,
    loadAnnotations,
    getDetail,
    deleteAnnotation
  } = useAnnotationStore();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<AnnotationDetail>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [expandedElements, setExpandedElements] = useState<Set<number>>(
    new Set()
  );
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
      <div className="h-full flex flex-col bg-neutral-950 text-white">
        {/* Header */}
        <div className="flex items-center gap-2 px-3 py-2 border-b border-neutral-800">
          <button
            onClick={() => setSelectedId(null)}
            className="p-1 text-neutral-400 hover:text-white rounded hover:bg-neutral-800"
          >
            <ArrowLeft size={16} />
          </button>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium truncate">
              {detail.url ?? 'Unknown URL'}
            </div>
            <div className="text-xs text-neutral-500">
              {detail.elements?.length ?? 0} elements
              {detail.viewport &&
                ` \u00b7 ${detail.viewport.width}\u00d7${detail.viewport.height}`}
            </div>
          </div>
          <button
            onClick={() => handleCopyPath(selectedId)}
            className="p-1 text-neutral-400 hover:text-white rounded hover:bg-neutral-800"
            title="Copy path"
          >
            <ClipboardCopy size={14} />
          </button>
          <button
            onClick={() => {
              void deleteAnnotation(selectedId);
              setSelectedId(null);
            }}
            className="p-1 text-neutral-400 hover:text-red-400 rounded hover:bg-neutral-800"
            title="Delete"
          >
            <Trash2 size={14} />
          </button>
        </div>

        {/* Context */}
        {detail.context && (
          <div className="px-3 py-2 border-b border-neutral-800">
            <div className="text-xs text-neutral-500 mb-1">Context</div>
            <div className="text-sm text-neutral-300">{detail.context}</div>
          </div>
        )}

        {/* Elements */}
        <div className="flex-1 overflow-y-auto">
          {detail.elements?.map((el, i) => (
            <div key={i} className="border-b border-neutral-800">
              {/* Element header — always visible */}
              <button
                onClick={() => toggleElement(i)}
                className="w-full flex items-center gap-2 px-3 py-2 hover:bg-neutral-900 text-left"
              >
                <span className="flex-shrink-0 w-5 h-5 rounded-full bg-cyan-900 text-cyan-300 text-xs flex items-center justify-center">
                  {i + 1}
                </span>
                {expandedElements.has(i) ? (
                  <ChevronDown size={12} className="text-neutral-500" />
                ) : (
                  <ChevronRight size={12} className="text-neutral-500" />
                )}
                <code className="text-xs text-neutral-300 truncate flex-1">
                  {el.selector}
                </code>
                <span className="text-xs text-neutral-600">{el.tag}</span>
              </button>

              {/* Expanded detail */}
              {expandedElements.has(i) && (
                <div className="px-3 pb-3 pl-10 space-y-1.5">
                  {el.comment && (
                    <div className="text-sm text-amber-300">
                      &ldquo;{el.comment}&rdquo;
                    </div>
                  )}
                  {el.text && (
                    <div className="text-xs text-neutral-400">
                      Text:{' '}
                      <span className="text-neutral-300">{el.text}</span>
                    </div>
                  )}
                  {el.boxModel && (
                    <div className="text-xs text-neutral-400">
                      Box: {el.rect.width}&times;{el.rect.height}
                      {' (pad: '}
                      {el.boxModel.padding.top} {el.boxModel.padding.right}{' '}
                      {el.boxModel.padding.bottom} {el.boxModel.padding.left})
                    </div>
                  )}
                  {el.accessibility && (
                    <div className="text-xs text-neutral-400">
                      A11y: role={el.accessibility.role ?? 'none'}
                      {el.accessibility.name &&
                        ` name="${el.accessibility.name}"`}
                      {el.accessibility.focusable && ' focusable'}
                    </div>
                  )}
                  {el.keyStyles &&
                    Object.keys(el.keyStyles).length > 0 && (
                      <div className="text-xs text-neutral-400">
                        Styles:{' '}
                        {Object.entries(el.keyStyles)
                          .map(([k, v]) => `${k}: ${v}`)
                          .join(', ')}
                      </div>
                    )}
                  {el.screenshotPath && (
                    <img
                      src={`fleet-image://${el.screenshotPath}`}
                      alt={`Element ${i + 1}`}
                      className="mt-1 rounded border border-neutral-700 max-w-full max-h-40 object-contain"
                    />
                  )}
                </div>
              )}
            </div>
          ))}
        </div>

        <AnnotateModal open={modalOpen} onClose={() => setModalOpen(false)} />
      </div>
    );
  }

  // ── List View ──
  return (
    <div className="h-full flex flex-col bg-neutral-950 text-white">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-neutral-800">
        <div className="flex items-center gap-2">
          <Crosshair size={16} className="text-cyan-400" />
          <span className="text-sm font-medium">Annotations</span>
        </div>
        <button
          onClick={() => setModalOpen(true)}
          className="px-2.5 py-1 text-xs bg-cyan-600 text-white rounded hover:bg-cyan-500"
        >
          New
        </button>
      </div>

      {/* List or empty state */}
      {!isLoaded ? (
        <div className="flex-1 flex items-center justify-center text-neutral-500 text-sm">
          Loading...
        </div>
      ) : annotations.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-3 text-neutral-500">
          <Crosshair size={32} className="text-neutral-700" />
          <p className="text-sm">No annotations yet</p>
          <button
            onClick={() => setModalOpen(true)}
            className="px-3 py-1.5 text-xs bg-cyan-600 text-white rounded hover:bg-cyan-500"
          >
            New Annotation
          </button>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto">
          {annotations.map((ann) => (
            <button
              key={ann.id}
              onClick={() => setSelectedId(ann.id)}
              className="w-full flex items-center gap-2 px-3 py-2.5 hover:bg-neutral-900 border-b border-neutral-800/50 text-left"
            >
              <div className="flex-1 min-w-0">
                <div className="text-sm text-neutral-200 truncate">
                  {ann.url}
                </div>
                <div className="text-xs text-neutral-500">
                  {timeAgo(ann.timestamp)} &middot; {ann.elementCount} element
                  {ann.elementCount !== 1 ? 's' : ''}
                </div>
              </div>
            </button>
          ))}
        </div>
      )}

      <AnnotateModal open={modalOpen} onClose={() => setModalOpen(false)} />
    </div>
  );
}
