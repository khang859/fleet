import { useState, useEffect } from 'react';
import { useImageStore } from '../../store/image-store';
import { ImageGrid } from './ImageGrid';
import { ImageDetail } from './ImageDetail';
import { ImageSettings } from './ImageSettings';
import { useDelayedFlag } from '../../hooks/use-delayed-flag';
import { Skeleton } from '../Skeleton';

type View = 'grid' | 'detail' | 'settings';

export function ImageGallery(): React.JSX.Element {
  const { generations, isLoaded, loadGenerations } = useImageStore();
  const [view, setView] = useState<View>('grid');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const showLoadingSkeleton = useDelayedFlag(!isLoaded);

  useEffect(() => {
    void loadGenerations();
  }, [loadGenerations]);
  useEffect(() => {
    const cleanup = window.fleet.images.onChanged(() => {
      void loadGenerations();
    });
    return cleanup;
  }, [loadGenerations]);

  const selectedGeneration = selectedId
    ? (generations.find((g) => g.id === selectedId) ?? null)
    : null;

  if (!isLoaded)
    return (
      <div className="flex-1">
        <span className="sr-only" role="status" aria-live="polite">
          Loading images…
        </span>
        {showLoadingSkeleton && (
          <div className="grid grid-cols-3 gap-2 p-3 content-start">
            {Array.from({ length: 9 }, (_, i) => (
              <Skeleton key={i} className="aspect-square w-full" />
            ))}
          </div>
        )}
      </div>
    );

  const inProgressCount = generations.filter(
    (g) => g.status === 'queued' || g.status === 'processing'
  ).length;

  return (
    <div className="flex flex-col h-full bg-neutral-900">
      <div className="flex items-center gap-1 px-3 pt-2 border-b border-neutral-800">
        <button
          className={`px-3 py-1.5 text-sm rounded-t transition active:scale-[0.97] ${view !== 'settings' ? 'bg-neutral-800 text-white' : 'text-neutral-400 hover:text-neutral-200'}`}
          onClick={() => {
            setView('grid');
            setSelectedId(null);
          }}
        >
          Gallery
          {inProgressCount > 0 && (
            <span className="ml-1.5 bg-cyan-500 text-white text-xs rounded-full px-1.5 py-0.5">
              {inProgressCount}
            </span>
          )}
        </button>
        <button
          className={`px-3 py-1.5 text-sm rounded-t transition active:scale-[0.97] ${view === 'settings' ? 'bg-neutral-800 text-white' : 'text-neutral-400 hover:text-neutral-200'}`}
          onClick={() => setView('settings')}
        >
          Settings
        </button>
      </div>
      <div className="flex-1 min-h-0">
        {view === 'settings' && <ImageSettings />}
        {view === 'grid' && (
          <ImageGrid
            generations={generations}
            onSelect={(id) => {
              setSelectedId(id);
              setView('detail');
            }}
          />
        )}
        {view === 'detail' && selectedGeneration && (
          <ImageDetail
            generation={selectedGeneration}
            onBack={() => {
              setSelectedId(null);
              setView('grid');
            }}
          />
        )}
      </div>
    </div>
  );
}
