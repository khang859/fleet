import { getScSpriteSheetUrl, getScTileUrl } from './sc-sprite-loader'
import { SC_SPRITE_ATLAS } from './sc-sprite-atlas'

export function StatusBar() {
  const url = getScSpriteSheetUrl()
  const rivet = SC_SPRITE_ATLAS['statusbar-rivet']
  const tileUrl = getScTileUrl('statusbar-tile')

  return (
    <div
      className="flex items-center justify-center px-3 flex-shrink-0 relative"
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

      <span className="text-xs font-mono text-teal-400 uppercase tracking-widest relative z-10">
        Starbase
      </span>
    </div>
  )
}
