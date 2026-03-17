import { type ReactNode, useState, useEffect } from 'react'
import { getScSpriteSheetUrl, getScTileUrl, isScSpriteReady } from './sc-sprite-loader'
import { SC_SPRITE_ATLAS } from './sc-sprite-atlas'

type CrtFrameProps = { children: ReactNode }

/**
 * NOTE on tiling: CSS background-repeat tiles the ENTIRE background image,
 * not a sub-region of a sprite sheet. For repeating tiles (edges, scanlines),
 * we use getScTileUrl() which extracts the sub-region into a standalone
 * data URL that can be tiled correctly.
 */

function SpriteDiv({
  spriteKey,
  className,
  style,
}: {
  spriteKey: string
  className?: string
  style?: React.CSSProperties
}) {
  const region = SC_SPRITE_ATLAS[spriteKey]
  if (!region) return null
  return (
    <div
      className={className}
      style={{
        backgroundImage: `url(${getScSpriteSheetUrl()})`,
        backgroundPosition: `-${region.x}px -${region.y}px`,
        backgroundRepeat: 'no-repeat',
        imageRendering: 'pixelated',
        width: region.w,
        height: region.h,
        flexShrink: 0,
        ...style,
      }}
    />
  )
}

export function CrtFrame({ children }: CrtFrameProps) {
  const [ready, setReady] = useState(isScSpriteReady())
  useEffect(() => {
    if (ready) return
    const interval = setInterval(() => {
      if (isScSpriteReady()) {
        setReady(true)
        clearInterval(interval)
      }
    }, 100)
    return () => clearInterval(interval)
  }, [ready])

  const edgeH = SC_SPRITE_ATLAS['crt-edge-h']
  const edgeV = SC_SPRITE_ATLAS['crt-edge-v']

  const edgeHUrl = ready ? getScTileUrl('crt-edge-h') : ''
  const edgeVUrl = ready ? getScTileUrl('crt-edge-v') : ''
  const scanlineUrl = ready ? getScTileUrl('crt-scanline') : ''

  return (
    <div className="flex flex-col h-full relative">
      {/* Top edge: corner-tl + repeating edge-h + corner-tr */}
      <div className="flex flex-shrink-0">
        <SpriteDiv spriteKey="crt-corner-tl" />
        <div
          className="flex-1"
          style={{
            backgroundImage: edgeHUrl ? `url(${edgeHUrl})` : 'none',
            backgroundRepeat: 'repeat-x',
            imageRendering: 'pixelated',
            height: edgeH?.h ?? 8,
          }}
        />
        <SpriteDiv spriteKey="crt-corner-tr" />
      </div>

      {/* Middle: edge-v + content + edge-v */}
      <div className="flex flex-1 min-h-0">
        <div
          className="flex-shrink-0"
          style={{
            backgroundImage: edgeVUrl ? `url(${edgeVUrl})` : 'none',
            backgroundRepeat: 'repeat-y',
            imageRendering: 'pixelated',
            width: edgeV?.w ?? 8,
          }}
        />
        <div className="flex-1 flex flex-col min-w-0 min-h-0 relative">
          {children}
          {/* Scanline overlay */}
          {scanlineUrl && (
            <div
              className="absolute inset-0 pointer-events-none z-10"
              style={{
                backgroundImage: `url(${scanlineUrl})`,
                backgroundRepeat: 'repeat',
                imageRendering: 'pixelated',
                opacity: 0.15,
              }}
            />
          )}
        </div>
        <div
          className="flex-shrink-0"
          style={{
            backgroundImage: edgeVUrl ? `url(${edgeVUrl})` : 'none',
            backgroundRepeat: 'repeat-y',
            imageRendering: 'pixelated',
            width: edgeV?.w ?? 8,
          }}
        />
      </div>

      {/* Bottom edge: corner-bl + repeating edge-h + corner-br */}
      <div className="flex flex-shrink-0">
        <SpriteDiv spriteKey="crt-corner-bl" />
        <div
          className="flex-1"
          style={{
            backgroundImage: edgeHUrl ? `url(${edgeHUrl})` : 'none',
            backgroundRepeat: 'repeat-x',
            imageRendering: 'pixelated',
            height: edgeH?.h ?? 8,
          }}
        />
        <SpriteDiv spriteKey="crt-corner-br" />
      </div>
    </div>
  )
}
