import { UpdatePill } from './UpdatePill';
import { ShortcutsHint } from './ShortcutsHint';

/**
 * The buttons in the title strip. On macOS the traffic lights own the left of
 * the strip, everywhere else the window controls own the right. One group, so a
 * single auto margin places them all instead of several splitting the space.
 */
export function TitleStripButtons(): React.JSX.Element {
  const positionClass = window.fleet.platform === 'darwin' ? 'ml-auto mr-3' : 'ml-3';

  return (
    <div className={`flex items-center gap-2 ${positionClass}`}>
      <UpdatePill />
      <ShortcutsHint />
    </div>
  );
}
