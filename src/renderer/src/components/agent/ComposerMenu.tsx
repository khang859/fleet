import type { ComposerMenuState } from './composer-menu';

/**
 * How both composer menus look: a list above the box with one row highlighted.
 * What is in the rows is the caller's, and everything about which row is
 * highlighted is `useComposerMenu`'s.
 */
export function ComposerMenu<T>(props: {
  menu: ComposerMenuState<T>;
  /** What the list is, for anyone who cannot see it. */
  label: string;
  itemKey: (item: T) => string;
  children: (item: T) => React.ReactNode;
}): React.JSX.Element | null {
  const { menu, label, itemKey, children } = props;
  if (!menu.open) return null;

  return (
    <div
      id={menu.id}
      role="listbox"
      aria-label={label}
      className="absolute bottom-full left-0 z-20 mb-1 max-h-56 w-full animate-in overflow-y-auto rounded border border-fleet-border bg-fleet-glass-surface-2 py-1 shadow-lg backdrop-blur-md fade-in zoom-in-95 duration-100"
    >
      {menu.items.map((item, i) => (
        // Options rather than buttons: focus never leaves the composer, so the
        // row a key press would take is named by `aria-activedescendant`
        // instead of being focused itself.
        <div
          key={itemKey(item)}
          id={`${menu.id}-${i}`}
          role="option"
          aria-selected={i === menu.active}
          // Mouse down rather than click: the textarea must not lose focus
          // first, or the menu closes before the pick lands.
          onMouseDown={(e) => {
            e.preventDefault();
            menu.pick(item);
          }}
          onMouseEnter={() => menu.hover(i)}
          className={`flex w-full cursor-pointer items-center gap-1.5 px-3 py-1.5 text-left ${
            i === menu.active ? 'bg-fleet-surface-3' : ''
          }`}
        >
          {children(item)}
        </div>
      ))}
    </div>
  );
}
