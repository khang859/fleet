import { memo } from 'react';
import { useStarCommandStore } from '../../store/star-command-store';
import { getScSpriteSheetUrl } from './sc-sprite-loader';
import { SC_SPRITE_ATLAS } from './sc-sprite-atlas';

const STATUS_DOT_KEYS: Record<string, string> = {
  active: 'chip-dot-active',
  hailing: 'chip-dot-hailing',
  error: 'chip-dot-error',
  complete: 'chip-dot-complete',
  idle: 'chip-dot-idle',
  lost: 'chip-dot-lost'
};

export const CrewChips = memo(function CrewChips() {
  const { crewList, sectors } = useStarCommandStore();
  const url = getScSpriteSheetUrl();
  const chipFrame = SC_SPRITE_ATLAS['chip-frame'];
  const divider = SC_SPRITE_ATLAS['statusbar-divider'];

  if (crewList.length === 0) return null;

  const bySector = new Map<string, typeof crewList>();
  for (const crew of crewList) {
    const list = bySector.get(crew.sector_id) ?? [];
    list.push(crew);
    bySector.set(crew.sector_id, list);
  }

  return (
    <div className="flex items-center gap-1 overflow-x-auto px-2 py-0.5 scrollbar-none flex-1">
      {Array.from(bySector.entries()).map(([sectorId, sectorCrew], idx) => {
        const sector = sectors.find((s) => s.id === sectorId);
        return (
          <div key={sectorId} className="flex items-center gap-1 flex-shrink-0">
            {idx > 0 && divider && (
              <div
                className="mx-1"
                style={{
                  backgroundImage: `url(${url})`,
                  backgroundPosition: `-${divider.x}px -${divider.y}px`,
                  backgroundRepeat: 'no-repeat',
                  imageRendering: 'pixelated',
                  width: divider.w,
                  height: divider.h
                }}
              />
            )}
            <span className="text-[9px] font-mono text-neutral-500 uppercase">
              {sector?.name ?? sectorId}
            </span>
            {sectorCrew.map((crew) => {
              const dotKey = STATUS_DOT_KEYS[crew.status] ?? 'chip-dot-idle';
              const dot = SC_SPRITE_ATLAS[dotKey];
              return (
                <div
                  key={crew.id}
                  className="relative flex items-center gap-1 px-1"
                  style={{
                    backgroundImage: `url(${url})`,
                    backgroundPosition: `-${chipFrame.x}px -${chipFrame.y}px`,
                    backgroundRepeat: 'no-repeat',
                    imageRendering: 'pixelated',
                    height: chipFrame.h,
                    minWidth: chipFrame.w
                  }}
                >
                  {dot && (
                    <div
                      style={{
                        backgroundImage: `url(${url})`,
                        backgroundPosition: `-${dot.x}px -${dot.y}px`,
                        backgroundRepeat: 'no-repeat',
                        imageRendering: 'pixelated',
                        width: dot.w,
                        height: dot.h
                      }}
                    />
                  )}
                  <span className="text-[8px] font-mono text-neutral-300 truncate max-w-[60px]">
                    {crew.id}
                  </span>
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
});
