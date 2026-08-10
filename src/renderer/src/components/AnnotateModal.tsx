import { useState, useEffect, useRef } from 'react';
import { X, Crosshair, MousePointer, Pencil } from 'lucide-react';
import type { AnnotateMode } from '../../../shared/annotate-types';
import { useAnnotationStore } from '../store/annotation-store';
import { registerAnnotateModalOpener } from '../lib/annotate-modal-bridge';
import { Overlay } from './Overlay';

interface AnnotateModalProps {
  open: boolean;
  onClose: () => void;
}

function looksLikeUrl(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.startsWith('http://') || trimmed.startsWith('https://');
}

export function AnnotateModal({ open, onClose }: AnnotateModalProps): React.JSX.Element | null {
  const [url, setUrl] = useState('');
  const [mode, setMode] = useState<AnnotateMode>('select');
  const [internalOpen, setInternalOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const startAnnotation = useAnnotationStore((s) => s.startAnnotation);

  const isOpen = open || internalOpen;

  useEffect(() => {
    return registerAnnotateModalOpener(() => setInternalOpen(true));
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    navigator.clipboard
      .readText()
      .then((text) => {
        if (looksLikeUrl(text)) {
          setUrl(text.trim());
        }
      })
      .catch(() => {
        // Clipboard access denied — leave empty
      });
    setTimeout(() => inputRef.current?.focus(), 50);
  }, [isOpen]);

  const handleClose = (): void => {
    setUrl('');
    setMode('select');
    setInternalOpen(false);
    onClose();
  };

  const handleStart = (): void => {
    const trimmed = url.trim();
    handleClose();
    void startAnnotation(trimmed || undefined, mode);
  };

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleStart();
    }
  };

  return (
    <Overlay open={isOpen} onClose={handleClose}>
      <div
        className="relative w-[480px] bg-fleet-surface-2 border border-fleet-border-strong rounded-lg shadow-xl p-6"
        onKeyDown={handleKeyDown}
      >
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Crosshair size={18} className="fleet-accent-text" />
            <h2 className="text-base font-medium text-fleet-text">New Annotation</h2>
          </div>
          <button
            onClick={handleClose}
            className="p-1 text-fleet-text-subtle hover:text-fleet-text rounded transition hover:bg-fleet-surface-3 active:scale-90"
          >
            <X size={16} />
          </button>
        </div>

        {/* URL input */}
        <div className="mb-4">
          <label className="block text-sm text-fleet-text-muted mb-1.5">URL</label>
          <input
            ref={inputRef}
            type="text"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://example.com"
            className="w-full px-3 py-2 bg-fleet-surface-3 border border-fleet-border-strong rounded-md text-sm text-fleet-text placeholder:text-fleet-text-subtle focus-ring"
          />
          <p className="mt-1 text-xs text-fleet-text-subtle">Leave empty to open a blank page</p>
        </div>

        {/* Mode selection */}
        <div className="mb-4">
          <label className="block text-sm text-fleet-text-muted mb-1.5">Mode</label>
          <div className="flex gap-2">
            <button
              onClick={() => setMode('select')}
              className={`flex-1 flex items-center justify-center gap-2 px-3 py-2.5 rounded-md border text-sm transition active:scale-[0.97] ${
                mode === 'select'
                  ? 'border-[color:var(--fleet-accent)] fleet-accent-bg-soft fleet-accent-text'
                  : 'border-fleet-border bg-fleet-surface-3 text-fleet-text-muted hover:border-fleet-border-strong'
              }`}
            >
              <MousePointer size={16} />
              Element Selection
            </button>
            <button
              onClick={() => setMode('draw')}
              className={`flex-1 flex items-center justify-center gap-2 px-3 py-2.5 rounded-md border text-sm transition active:scale-[0.97] ${
                mode === 'draw'
                  ? 'border-[color:var(--fleet-accent)] fleet-accent-bg-soft fleet-accent-text'
                  : 'border-fleet-border bg-fleet-surface-3 text-fleet-text-muted hover:border-fleet-border-strong'
              }`}
            >
              <Pencil size={16} />
              Free Draw
            </button>
          </div>
        </div>

        {/* Actions */}
        <div className="flex justify-end gap-2">
          <button
            onClick={handleClose}
            className="px-3 py-1.5 text-sm text-fleet-text-muted hover:text-fleet-text rounded-md transition hover:bg-fleet-surface-3 active:scale-[0.97]"
          >
            Cancel
          </button>
          <button
            onClick={handleStart}
            className="px-3 py-1.5 text-sm fleet-accent-bg fleet-accent-bg-hover text-white rounded-md transition active:scale-[0.97]"
          >
            Start
          </button>
        </div>
      </div>
    </Overlay>
  );
}
