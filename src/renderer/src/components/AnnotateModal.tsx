import { useState, useEffect, useRef } from 'react';
import { X, Crosshair } from 'lucide-react';
import { useAnnotationStore } from '../store/annotation-store';
import { registerAnnotateModalOpener } from '../lib/annotate-modal-bridge';

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

  if (!isOpen) return null;

  const handleClose = (): void => {
    setUrl('');
    setInternalOpen(false);
    onClose();
  };

  const handleStart = (): void => {
    const trimmed = url.trim();
    handleClose();
    void startAnnotation(trimmed || undefined);
  };

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleStart();
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      handleClose();
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={handleClose}
    >
      <div
        className="relative w-[480px] bg-neutral-900 border border-neutral-700 rounded-lg shadow-xl p-6"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Crosshair size={18} className="text-cyan-400" />
            <h2 className="text-base font-medium text-white">New Annotation</h2>
          </div>
          <button
            onClick={handleClose}
            className="p-1 text-neutral-500 hover:text-white rounded hover:bg-neutral-800"
          >
            <X size={16} />
          </button>
        </div>

        {/* URL input */}
        <div className="mb-4">
          <label className="block text-sm text-neutral-400 mb-1.5">URL</label>
          <input
            ref={inputRef}
            type="text"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://example.com"
            className="w-full px-3 py-2 bg-neutral-800 border border-neutral-700 rounded-md text-sm text-white placeholder-neutral-500 focus:outline-none focus:ring-1 focus:ring-cyan-500 focus:border-cyan-500"
          />
          <p className="mt-1 text-xs text-neutral-500">
            Leave empty to open a blank page
          </p>
        </div>

        {/* Actions */}
        <div className="flex justify-end gap-2">
          <button
            onClick={handleClose}
            className="px-3 py-1.5 text-sm text-neutral-400 hover:text-white rounded-md hover:bg-neutral-800"
          >
            Cancel
          </button>
          <button
            onClick={handleStart}
            className="px-3 py-1.5 text-sm bg-cyan-600 text-white rounded-md hover:bg-cyan-500"
          >
            Start
          </button>
        </div>
      </div>
    </div>
  );
}
