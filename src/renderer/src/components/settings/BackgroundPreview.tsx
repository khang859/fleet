import type { CSSProperties } from 'react';
import type { TerminalBackground } from '../../../../shared/types';
import { toFleetImageUrl } from '../../../../shared/path-platform';
import { paneGround, paneBackdrop } from '../../lib/theme';

const FIT_STYLES: Record<TerminalBackground['fit'], { size: string; repeat: string }> = {
  cover: { size: 'cover', repeat: 'no-repeat' },
  contain: { size: 'contain', repeat: 'no-repeat' },
  center: { size: 'auto', repeat: 'no-repeat' },
  tile: { size: 'auto', repeat: 'repeat' }
};

function edgeFadeStyle(fadeX: number, fadeY: number): CSSProperties {
  if (!fadeX && !fadeY) return {};
  const ramp = (dir: string, fade: number): string => {
    const start = `${(fade * 100).toFixed(1)}%`;
    const end = `${(100 - fade * 100).toFixed(1)}%`;
    return `linear-gradient(to ${dir}, transparent, #000 ${start}, #000 ${end}, transparent)`;
  };
  const layers: string[] = [];
  if (fadeX) layers.push(ramp('right', fadeX));
  if (fadeY) layers.push(ramp('bottom', fadeY));
  return {
    maskImage: layers.join(', '),
    ...(layers.length > 1 ? { maskComposite: 'intersect' } : {})
  };
}

export function BackgroundPreview(props: {
  background: TerminalBackground;
  previewImagePath: string | null;
  themeBackground: string;
  themeForeground: string;
}): React.JSX.Element {
  const { background, previewImagePath, themeBackground, themeForeground } = props;

  const imageLayerStyle: CSSProperties | null = previewImagePath
    ? {
        inset: background.blur > 0 ? -background.blur * 2 : 0,
        backgroundImage: `url("${toFleetImageUrl(previewImagePath)}")`,
        backgroundSize: FIT_STYLES[background.fit].size,
        backgroundRepeat: FIT_STYLES[background.fit].repeat,
        backgroundPosition: 'center',
        filter: background.blur > 0 ? `blur(${background.blur}px)` : undefined,
        opacity: background.opacity,
        ...edgeFadeStyle(background.edgeFadeX, background.edgeFadeY)
      }
    : null;

  return (
    // Layered exactly as the window is: app canvas, the image dimmed onto it,
    // the pane's ground over that, text on top.
    <div
      className="h-28 w-full rounded-md overflow-hidden border border-fleet-border-strong relative"
      style={{ backgroundColor: 'var(--fleet-bg)' }}
    >
      {imageLayerStyle && (
        <div
          aria-hidden
          className="absolute pointer-events-none"
          style={{ ...imageLayerStyle, zIndex: 0 }}
        />
      )}
      {/* The pane's own ground, between the picture and the text, exactly as it
          sits in a real pane. Without it the tint and frost sliders would move
          nothing here and read as broken. */}
      <div
        aria-hidden
        className="absolute inset-0 pointer-events-none"
        style={{
          backgroundColor: paneGround(themeBackground, !!imageLayerStyle, background.paneTint),
          backdropFilter: paneBackdrop(
            !!imageLayerStyle,
            background.paneFrost,
            background.paneSaturation
          ),
          zIndex: 1
        }}
      />
      <div
        className="relative p-2 text-[11px] leading-relaxed font-mono"
        style={{ color: themeForeground, zIndex: 2 }}
      >
        <div>~/fleet $ npm run dev</div>
        <div style={{ color: '#4ade80' }}>✓ build succeeded</div>
        <div>
          ~/fleet ${' '}
          <span
            style={{
              display: 'inline-block',
              width: '0.6em',
              height: '1em',
              backgroundColor: themeForeground,
              verticalAlign: 'text-bottom',
              animation: 'fleet-cursor-blink 1s step-end infinite'
            }}
          />
        </div>
      </div>
    </div>
  );
}
