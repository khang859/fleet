import { useMemo, useState, useEffect } from 'react';
import type { ImageGenerationMeta } from '../../../../shared/types';

type ImageGridProps = {
  generations: ImageGenerationMeta[];
  onSelect: (id: string) => void;
};

function Thumbnail({ generation }: { generation: ImageGenerationMeta }): React.JSX.Element {
  const [src, setSrc] = useState<string | null>(null);
  const firstImage = generation.images.find((img) => img.filename);

  useEffect(() => {
    if (!firstImage?.filename) return;
    const filePath = `${window.fleet.homeDir}/.fleet/images/generations/${generation.id}/${firstImage.filename}`;
    void window.fleet.file.readBinary(filePath).then((result) => {
      if (result.success && result.data) {
        setSrc(`data:${result.data.mimeType};base64,${result.data.base64}`);
      }
    });
  }, [generation.id, firstImage?.filename]);

  if (src) return <img src={src} alt={generation.prompt} className="w-full h-full object-cover" />;

  if (generation.status === 'queued' || generation.status === 'processing') {
    return (
      <div className="w-full h-full flex items-center justify-center text-neutral-600">
        <svg className="w-8 h-8 animate-spin" viewBox="0 0 24 24" fill="none">
          <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" opacity="0.3" />
          <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      </div>
    );
  }

  return <div className="w-full h-full flex items-center justify-center text-neutral-600 text-2xl">!</div>;
}

function StatusBadge({ status }: { status: string }): React.JSX.Element | null {
  switch (status) {
    case 'queued': case 'processing':
      return <span className="absolute top-2 right-2 w-3 h-3 bg-cyan-400 rounded-full animate-pulse" />;
    case 'failed': case 'timeout':
      return <span className="absolute top-2 right-2 w-3 h-3 bg-red-400 rounded-full" />;
    case 'partial':
      return <span className="absolute top-2 right-2 w-3 h-3 bg-amber-400 rounded-full" />;
    default:
      return null;
  }
}

export function ImageGrid({ generations, onSelect }: ImageGridProps): React.JSX.Element {
  const sorted = useMemo(() => [...generations].sort((a, b) => b.createdAt.localeCompare(a.createdAt)), [generations]);

  if (sorted.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-neutral-500 text-sm p-8">
        <p>No images yet. Generate one with:</p>
        <code className="mt-2 text-xs bg-neutral-800 rounded px-2 py-1">fleet images generate --prompt &quot;...&quot;</code>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3 p-4 overflow-y-auto">
      {sorted.map((gen) => (
        <button key={gen.id} className="relative bg-neutral-800 rounded-lg overflow-hidden cursor-pointer hover:ring-2 hover:ring-cyan-500 transition-all aspect-square group" onClick={() => onSelect(gen.id)}>
          <Thumbnail generation={gen} />
          <StatusBadge status={gen.status} />
          <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 to-transparent p-2 opacity-0 group-hover:opacity-100 transition-opacity">
            <p className="text-xs text-white truncate">{gen.prompt}</p>
            <p className="text-xs text-neutral-400">{gen.model.split('/').pop()}</p>
          </div>
        </button>
      ))}
    </div>
  );
}
