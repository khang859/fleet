import { getScSpriteSheetUrl } from './sc-sprite-loader'
import { SC_SPRITE_ATLAS } from './sc-sprite-atlas'

const ADMIRAL_STATES: readonly string[] = ['default', 'speaking', 'thinking', 'alert', 'standby']
const CREW_VARIANTS: readonly string[] = ['hoodie', 'headphones', 'robot', 'cap', 'glasses']

type AvatarProps = {
  type: 'admiral' | 'crew'
  variant?: string
  size?: number
}

export function Avatar({ type, variant, size = 32 }: AvatarProps) {
  const url = getScSpriteSheetUrl()

  let key: string
  if (type === 'admiral') {
    const state =
      variant && ADMIRAL_STATES.includes(variant)
        ? variant
        : 'default'
    key = `admiral-${state}`
  } else {
    const v =
      variant && CREW_VARIANTS.includes(variant)
        ? variant
        : 'hoodie'
    key = `crew-${v}`
  }

  const region = SC_SPRITE_ATLAS[key]
  if (!region) return null

  const scale = size / region.w
  const scaledSheetW = 512 * scale

  return (
    <div
      className="flex-shrink-0 rounded"
      style={{
        backgroundImage: `url(${url})`,
        backgroundRepeat: 'no-repeat',
        backgroundSize: `${scaledSheetW}px auto`,
        backgroundPosition: `-${region.x * scale}px -${region.y * scale}px`,
        imageRendering: 'pixelated',
        width: size,
        height: size,
      }}
    />
  )
}
