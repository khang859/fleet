import { UpdatePill } from './UpdatePill';
import { ShortcutsHint } from './ShortcutsHint';
import { WindowControls } from './WindowControls';
import { drawsOwnWindowControls } from '../../../shared/window-controls';

/**
 * The buttons in the title strip. On macOS the traffic lights own the left of
 * the strip, everywhere else the window controls own the right. One group, so a
 * single auto margin places them all instead of several splitting the space.
 */
export function TitleStripButtons(): React.JSX.Element {
  const platform = window.fleet.platform;
  const positionClass = platform === 'darwin' ? 'ml-auto mr-3' : 'ml-3';

  return (
    <>
      <div className={`flex items-center gap-2 ${positionClass}`}>
        <UpdatePill />
        <ShortcutsHint />
      </div>
      {/* Centered in the 32px above the cards (the 24px strip plus their 8px
          gutter) rather than in the strip, so it hangs 4px below it. Right
          edge lines up with the cards' gutter. */}
      {drawsOwnWindowControls(platform) && (
        <div className="absolute top-1 right-2">
          <WindowControls />
        </div>
      )}
    </>
  );
}
