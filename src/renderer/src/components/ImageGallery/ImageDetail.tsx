import { useState, useEffect } from 'react';
import type { ImageGenerationMeta } from '../../../../shared/types';
import { useImageStore } from '../../store/image-store';

type ImageDetailProps = {
  generation: ImageGenerationMeta;
  onBack: () => void;
};

function DetailImage({
  generationId,
  filename,
  alt
}: {
  generationId: string;
  filename: string;
  alt: string;
}): React.JSX.Element {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    const filePath = `${window.fleet.homeDir}/.fleet/images/generations/${generationId}/${filename}`;
    void window.fleet.file.readBinary(filePath).then((result) => {
      if (result.success && result.data)
        setSrc(`data:${result.data.mimeType};base64,${result.data.base64}`);
    });
  }, [generationId, filename]);

  if (!src) return <div className="w-32 h-32 bg-neutral-800 rounded animate-pulse" />;
  return <img src={src} alt={alt} className="max-w-full max-h-[70vh] rounded-lg object-contain" />;
}

export function ImageDetail({ generation, onBack }: ImageDetailProps): React.JSX.Element {
  const { retry, deleteGeneration } = useImageStore();
  const gen = generation;
  const images = gen.images.filter((img) => img.filename);
  const failedImages = gen.images.filter((img) => !img.filename);

  const handleRetry = (): void => {
    void retry(gen.id);
  };
  const handleDelete = (): void => {
    void deleteGeneration(gen.id);
    onBack();
  };
  const handleCopyPath = (): void => {
    void navigator.clipboard.writeText(`~/.fleet/images/generations/${gen.id}`);
  };

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 p-3 border-b border-neutral-800">
        <button className="text-neutral-400 hover:text-white text-sm" onClick={onBack}>
          &larr; Back
        </button>
        <span className="text-sm text-neutral-500 font-mono">{gen.id}</span>
      </div>
      <div className="flex flex-1 min-h-0">
        <div className="flex-1 flex items-center justify-center bg-neutral-950 p-4 overflow-auto">
          {images.length > 0 ? (
            <div className="flex gap-4 flex-wrap justify-center">
              {images.map((img, i) => (
                <DetailImage
                  key={i}
                  generationId={gen.id}
                  filename={img.filename!}
                  alt={`Generated image ${i + 1}`}
                />
              ))}
            </div>
          ) : (
            <div className="text-neutral-500 text-sm">
              {gen.status === 'queued' || gen.status === 'processing'
                ? 'Generating...'
                : 'No images available'}
            </div>
          )}
        </div>
        <div className="w-72 border-l border-neutral-800 overflow-y-auto p-4 space-y-3">
          <div>
            <span className="text-xs text-neutral-500">Status</span>
            <p
              className={`text-sm ${gen.status === 'completed' ? 'text-green-400' : gen.status === 'failed' || gen.status === 'timeout' ? 'text-red-400' : 'text-cyan-400'}`}
            >
              {gen.status}
            </p>
          </div>
          <div>
            <span className="text-xs text-neutral-500">Prompt</span>
            <p className="text-sm text-neutral-200">{gen.prompt}</p>
          </div>
          <div>
            <span className="text-xs text-neutral-500">Provider</span>
            <p className="text-sm text-neutral-200">{gen.provider}</p>
          </div>
          <div>
            <span className="text-xs text-neutral-500">Model</span>
            <p className="text-sm text-neutral-200">{gen.model}</p>
          </div>
          <div>
            <span className="text-xs text-neutral-500">Mode</span>
            <p className="text-sm text-neutral-200">{gen.mode}</p>
          </div>
          {gen.params.resolution && (
            <div>
              <span className="text-xs text-neutral-500">Resolution</span>
              <p className="text-sm text-neutral-200">{gen.params.resolution}</p>
            </div>
          )}
          {gen.params.aspect_ratio && (
            <div>
              <span className="text-xs text-neutral-500">Aspect Ratio</span>
              <p className="text-sm text-neutral-200">{gen.params.aspect_ratio}</p>
            </div>
          )}
          {gen.params.output_format && (
            <div>
              <span className="text-xs text-neutral-500">Format</span>
              <p className="text-sm text-neutral-200">{gen.params.output_format}</p>
            </div>
          )}
          <div>
            <span className="text-xs text-neutral-500">Created</span>
            <p className="text-sm text-neutral-200">{new Date(gen.createdAt).toLocaleString()}</p>
          </div>
          {gen.completedAt && (
            <div>
              <span className="text-xs text-neutral-500">Completed</span>
              <p className="text-sm text-neutral-200">
                {new Date(gen.completedAt).toLocaleString()}
              </p>
            </div>
          )}
          {gen.referenceImages.length > 0 && (
            <div>
              <span className="text-xs text-neutral-500">Reference Images</span>
              {gen.referenceImages.map((ref, i) => (
                <p key={i} className="text-xs text-neutral-400 truncate">
                  {ref}
                </p>
              ))}
            </div>
          )}
          {gen.error && (
            <div>
              <span className="text-xs text-neutral-500">Error</span>
              <p className="text-sm text-red-400">{gen.error}</p>
            </div>
          )}
          {failedImages.length > 0 && (
            <div>
              <span className="text-xs text-neutral-500">Failed Downloads</span>
              {failedImages.map((img, i) => (
                <p key={i} className="text-xs text-red-400">
                  {img.error}
                </p>
              ))}
            </div>
          )}
          {gen.providerRequestId && (
            <div>
              <span className="text-xs text-neutral-500">Request ID</span>
              <p className="text-xs text-neutral-400 font-mono">{gen.providerRequestId}</p>
            </div>
          )}
          <div className="pt-3 border-t border-neutral-800 space-y-2">
            {(gen.status === 'failed' || gen.status === 'timeout' || gen.status === 'partial') && (
              <button
                className="w-full text-sm bg-cyan-600 hover:bg-cyan-500 text-white rounded px-3 py-1.5"
                onClick={handleRetry}
              >
                Retry
              </button>
            )}
            <button
              className="w-full text-sm bg-neutral-700 hover:bg-neutral-600 text-neutral-200 rounded px-3 py-1.5"
              onClick={handleCopyPath}
            >
              Copy Path
            </button>
            <button
              className="w-full text-sm bg-red-900/50 hover:bg-red-800/50 text-red-300 rounded px-3 py-1.5"
              onClick={handleDelete}
            >
              Delete
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
