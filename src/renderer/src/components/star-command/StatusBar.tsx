import { useStarCommandStore } from '../../store/star-command-store'
import { getScSpriteSheetUrl, getScTileUrl } from './sc-sprite-loader'
import { SC_SPRITE_ATLAS } from './sc-sprite-atlas'
import { CrewChips } from './CrewChips'

export function StatusBar() {
  const { crewList, sectors } = useStarCommandStore()
  const url = getScSpriteSheetUrl()
  const rivet = SC_SPRITE_ATLAS['statusbar-rivet']
  const tileUrl = getScTileUrl('statusbar-tile')

  const activeCrew = crewList.filter((c) => c.status === 'active').length
  const totalCrew = crewList.length
  const activeSectors = new Set(
    crewList.filter((c) => c.status === 'active').map((c) => c.sector_id),
  )

  return (
    <div
      className="flex items-center gap-3 px-3 flex-shrink-0 relative"
      style={{
        backgroundImage: tileUrl ? `url(${tileUrl})` : 'none',
        backgroundRepeat: 'repeat-x',
        backgroundSize: 'auto 100%',
        imageRendering: 'pixelated',
        height: 32,
      }}
    >
      {/* Rivets at far ends */}
      {rivet && (
        <>
          <div
            className="absolute"
            style={{
              backgroundImage: `url(${url})`,
              backgroundPosition: `-${rivet.x}px -${rivet.y}px`,
              backgroundRepeat: 'no-repeat',
              imageRendering: 'pixelated',
              width: rivet.w,
              height: rivet.h,
              left: 8,
              top: (32 - rivet.h) / 2,
            }}
          />
          <div
            className="absolute"
            style={{
              backgroundImage: `url(${url})`,
              backgroundPosition: `-${rivet.x}px -${rivet.y}px`,
              backgroundRepeat: 'no-repeat',
              imageRendering: 'pixelated',
              width: rivet.w,
              height: rivet.h,
              right: 8,
              top: (32 - rivet.h) / 2,
            }}
          />
        </>
      )}

      <span className="text-xs font-mono text-teal-400 uppercase tracking-widest relative z-10 flex-shrink-0 pl-4">
        Starbase
      </span>
      <CrewChips />
      <span className="text-xs font-mono text-neutral-300 relative z-10 flex-shrink-0 pr-4">
        {activeCrew}/{totalCrew} crew · {activeSectors.size}/{sectors.length} sectors
      </span>
    </div>
  )
}
