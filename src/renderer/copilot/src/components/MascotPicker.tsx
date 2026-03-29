import { useEffect } from 'react';
import { useCopilotStore } from '../store/copilot-store';
import { Button } from './ui/button';
import { ScrollArea } from './ui/scroll-area';
import { ChevronLeft } from 'lucide-react';
import { MASCOT_REGISTRY } from '../../../../shared/mascots';
import { getSpriteSheet } from '../assets/sprite-loader';

export function MascotPicker(): React.JSX.Element {
  const settings = useCopilotStore((s) => s.settings);
  const setView = useCopilotStore((s) => s.setView);
  const loadSettings = useCopilotStore((s) => s.loadSettings);
  const updateSettings = useCopilotStore((s) => s.updateSettings);

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-neutral-700">
        <Button variant="ghost" size="sm" onClick={() => setView('sessions')}>
          <ChevronLeft size={14} />
        </Button>
        <span className="text-xs font-medium text-neutral-200">Mascots</span>
      </div>

      <ScrollArea className="flex-1">
        <div className="px-3 py-2">
          <div className="flex gap-2">
            {MASCOT_REGISTRY.map((mascot) => {
              const isSelected = (settings?.spriteSheet ?? 'officer') === mascot.id;
              const sheet = getSpriteSheet(mascot.id);
              return (
                <button
                  key={mascot.id}
                  onClick={() => void updateSettings({ spriteSheet: mascot.id })}
                  className={`flex flex-col items-center gap-1 p-1.5 rounded border transition-colors ${
                    isSelected
                      ? 'border-blue-500 bg-blue-500/10'
                      : 'border-neutral-700 hover:border-neutral-500'
                  }`}
                >
                  <div
                    style={{
                      width: 48,
                      height: 48,
                      backgroundImage: `url(${sheet})`,
                      backgroundPosition: `-${mascot.thumbnailFrame * 128 * (48 / 128)}px 0`,
                      backgroundSize: `${128 * 9 * (48 / 128)}px ${48}px`,
                      backgroundRepeat: 'no-repeat',
                      imageRendering: 'pixelated',
                    }}
                  />
                  <span className="text-[10px] text-neutral-300">{mascot.name}</span>
                </button>
              );
            })}
          </div>
        </div>
      </ScrollArea>
    </div>
  );
}
