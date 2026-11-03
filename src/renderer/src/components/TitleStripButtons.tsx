import { UpdatePill } from './UpdatePill';
import { ShortcutsHint } from './ShortcutsHint';
import { WindowControls } from './WindowControls';
import { drawsOwnWindowControls } from '../../../shared/window-controls';

/**
 * The buttons in the title strip. On macOS the traffic lights own the left of
 * the strip, everywhere else the window controls own the right.
 *
 * Both groups are centered at y=16, the middle of the 32px above the cards (the
 * 24px strip plus their 8px gutter), which is also where macOS centers its
 * traffic lights. That puts them 4px below the strip's own middle, so they are
 * placed absolutely and hang into the gutter.
 */
export function TitleStripButtons(): React.JSX.Element {
  const platform = window.fleet.platform;
  const positionClass = platform === 'darwin' ? 'right-3' : 'left-3';

  return (
    <>
      <div className={`absolute top-1 h-6 flex items-center gap-2 ${positionClass}`}>
        <UpdatePill />
        <ShortcutsHint />
      </div>
      {/* Right edge lines up with the cards' gutter. */}
      {drawsOwnWindowControls(platform) && (
        <div className="absolute top-1 right-2">
          <WindowControls />
        </div>
      )}
    </>
  );
}
