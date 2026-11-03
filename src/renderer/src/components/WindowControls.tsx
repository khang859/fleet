import { useEffect, useState } from 'react';
import { Copy, Minus, Square, X } from 'lucide-react';
import type { WindowControlAction } from '../../../shared/window-controls';

const BUTTON_CLASS =
  'w-10 h-full flex items-center justify-center cursor-pointer text-fleet-text-subtle transition-colors';

/**
 * Minimize, maximize and close, drawn by Fleet on the platforms where the
 * native overlay cannot match the chrome (see `drawsOwnWindowControls`).
 * One glass pill, sized as the click targets for the window itself.
 */
export function WindowControls(): React.JSX.Element {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    let live = true;
    void window.fleet.windowControls.isMaximized().then((value) => {
      if (live) setMaximized(value);
    });
    const off = window.fleet.windowControls.onMaximizedChange(setMaximized);
    return () => {
      live = false;
      off();
    };
  }, []);

  const run = (action: WindowControlAction) => (): void => window.fleet.windowControls.run(action);

  return (
    <div
      className="flex h-6 rounded-full overflow-hidden bg-fleet-glass-chrome border border-fleet-border"
      style={{ WebkitAppRegion: 'no-drag' }}
    >
      <button
        onClick={run('minimize')}
        className={`${BUTTON_CLASS} hover:text-fleet-text-secondary hover:bg-fleet-surface-2`}
        aria-label="Minimize"
        title="Minimize"
      >
        <Minus size={14} />
      </button>
      <button
        onClick={run('toggle-maximize')}
        className={`${BUTTON_CLASS} hover:text-fleet-text-secondary hover:bg-fleet-surface-2`}
        aria-label={maximized ? 'Restore' : 'Maximize'}
        title={maximized ? 'Restore' : 'Maximize'}
      >
        {maximized ? <Copy size={12} /> : <Square size={12} />}
      </button>
      <button
        onClick={run('close')}
        className={`${BUTTON_CLASS} hover:text-white hover:bg-red-500`}
        aria-label="Close"
        title="Close"
      >
        <X size={14} />
      </button>
    </div>
  );
}
