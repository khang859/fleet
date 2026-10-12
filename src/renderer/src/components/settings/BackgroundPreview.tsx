import type { TerminalBackground } from '../../../../shared/types';
import { backgroundMediaKind } from '../../../../shared/background-media';
import { backgroundLayerStyle } from '../../lib/background-style';
import { paneGround, paneBackdrop } from '../../lib/theme';
import { BackgroundVideo } from '../BackgroundVideo';

export function BackgroundPreview(props: {
  background: TerminalBackground;
  previewPath: string | null;
  themeBackground: string;
  themeForeground: string;
}): React.JSX.Element {
  const { background, previewPath, themeBackground, themeForeground } = props;

  return (
    // Layered exactly as the window is: app canvas, the background dimmed onto it,
    // the pane's ground over that, text on top.
    <div
      className="h-28 w-full rounded-md overflow-hidden border border-fleet-border-strong relative"
      style={{ backgroundColor: 'var(--fleet-bg)' }}
    >
      {previewPath && (
        <div
          aria-hidden
          className="absolute pointer-events-none"
          style={{
            ...backgroundLayerStyle(background, previewPath),
            opacity: background.opacity,
            zIndex: 0
          }}
        >
          {backgroundMediaKind(previewPath) === 'video' && (
            <BackgroundVideo path={previewPath} fit={background.fit} />
          )}
        </div>
      )}
      {/* The pane's own ground, between the picture and the text, exactly as it
          sits in a real pane. Without it the tint and frost sliders would move
          nothing here and read as broken. */}
      <div
        aria-hidden
        className="absolute inset-0 pointer-events-none"
        style={{
          backgroundColor: paneGround(themeBackground, !!previewPath, background.paneTint),
          backdropFilter: paneBackdrop(
            !!previewPath,
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
