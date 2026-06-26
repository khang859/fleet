import { useState } from 'react';
import { Maximize2, Copy, RefreshCw, Pencil } from 'lucide-react';
import { toFleetImageUrl } from '../../../../shared/path-platform';
import type { ChatImageRef } from '../../../../shared/chat-types';
import { ChatImageLightbox } from './ChatImageLightbox';

export function ChatImage({
  image,
  prompt,
  onEdit,
  onRegenerate
}: {
  image: ChatImageRef;
  prompt?: string;
  onEdit?: () => void;
  onRegenerate?: () => void;
}): React.JSX.Element {
  const [zoom, setZoom] = useState(false);
  const [showFullPrompt, setShowFullPrompt] = useState(false);
  const [copied, setCopied] = useState(false);

  const src = toFleetImageUrl(image.ref);
  const alt = prompt ? prompt.slice(0, 100) : 'Generated image';

  const copyImage = async (): Promise<void> => {
    try {
      const res = await fetch(src);
      const blob = await res.blob();
      await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // best-effort; ignore clipboard failures
    }
  };

  return (
    <div className="group relative my-1 inline-block max-w-full">
      <img
        src={src}
        alt={alt}
        onClick={() => setZoom(true)}
        className="max-h-[60vh] max-w-[512px] cursor-zoom-in rounded-lg"
      />

      {/* Hover action bar */}
      <div className="absolute right-1 top-1 hidden items-center gap-0.5 rounded bg-black/50 p-0.5 group-hover:flex">
        <button
          type="button"
          aria-label="View full size"
          onClick={() => setZoom(true)}
          className="rounded p-1 text-white hover:bg-white/20"
        >
          <Maximize2 size={14} />
        </button>
        <button
          type="button"
          aria-label={copied ? 'Copied' : 'Copy image'}
          onClick={() => {
            void copyImage();
          }}
          className="rounded p-1 text-white hover:bg-white/20"
        >
          <Copy size={14} />
        </button>
        {onRegenerate !== undefined && (
          <button
            type="button"
            aria-label="Regenerate image"
            onClick={onRegenerate}
            className="rounded p-1 text-white hover:bg-white/20"
          >
            <RefreshCw size={14} />
          </button>
        )}
        {onEdit !== undefined && (
          <button
            type="button"
            aria-label="Edit this image"
            onClick={onEdit}
            className="rounded p-1 text-white hover:bg-white/20"
          >
            <Pencil size={14} />
          </button>
        )}
      </div>

      {/* Collapsible prompt caption */}
      {prompt !== undefined && (
        <button
          type="button"
          onClick={() => setShowFullPrompt((s) => !s)}
          className="mt-0.5 block max-w-full text-left text-[11px] text-fleet-text-muted"
        >
          {showFullPrompt ? (
            <span>Prompt: {prompt}</span>
          ) : (
            <span className="truncate block max-w-[512px]">Prompt: {prompt}</span>
          )}
        </button>
      )}

      {zoom && <ChatImageLightbox filePath={image.ref} onClose={() => setZoom(false)} />}
    </div>
  );
}
