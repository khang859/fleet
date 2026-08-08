import { useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { MoreHorizontal } from 'lucide-react';
import { popperAnim } from '../../../lib/motion';

/**
 * The actions belonging to one row of a settings list.
 *
 * Behind a menu rather than laid out as icons, and the trigger is always
 * visible rather than appearing on hover. A row is read far more often than it
 * is acted on, so the actions should not add furniture to every line - but a
 * control that only exists while the pointer is over it is a control most
 * people never find, and on a list where one of the actions is "remove" that
 * matters. One quiet glyph, always there, is the trade both halves want.
 */
export function RowMenu({
  label,
  children
}: {
  /** What the menu belongs to, for the screen reader. */
  label: string;
  /** `MenuItem`s. Given `close` so picking one dismisses the menu. */
  children: (close: (run: () => void) => () => void) => React.ReactNode;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const pick = (run: () => void) => (): void => {
    setOpen(false);
    run();
  };

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label={`More actions for ${label}`}
          className="shrink-0 rounded p-1 text-fleet-text-subtle transition-colors hover:bg-fleet-surface-3 hover:text-fleet-text focus-ring"
        >
          <MoreHorizontal size={15} />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={4}
          className={`z-50 w-44 overflow-hidden rounded-md border border-fleet-border-strong bg-fleet-surface-2 py-1 shadow-xl ${popperAnim}`}
        >
          {children(pick)}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

export function MenuItem({
  icon,
  danger = false,
  onClick,
  children
}: {
  icon: React.ReactNode;
  danger?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors hover:bg-fleet-surface-3 ${
        danger ? 'text-red-300' : 'text-fleet-text-secondary'
      }`}
    >
      <span className="shrink-0">{icon}</span>
      {children}
    </button>
  );
}
