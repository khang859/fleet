import { useId, useState } from 'react';

/**
 * The list that comes up over the composer, minus its looks.
 *
 * There are two of them - `/` for commands and `@` for files - and they are the
 * same widget: a list above the box, one row highlighted, arrows to move, Enter
 * or Tab to take it, Escape to make it go away. Written twice they drifted
 * within a day of each other, so the highlight and the keys live here and each
 * caller brings only what is actually different: where the rows come from, what
 * a row looks like, and what taking one does.
 *
 * Focus never leaves the textarea. That is why the rows end up as options
 * rather than buttons and why the composer itself is the combobox - a menu the
 * keyboard can drive without the caret leaving the message being typed.
 */

/**
 * The part of a menu the composer has to name out loud, whatever is in it -
 * `aria-controls` and `aria-activedescendant` want an element and a row, and
 * neither cares which of the two menus it is.
 */
export interface ComposerMenuAnchor {
  id: string;
  /** The row the next Enter would take. */
  active: number;
}

export interface ComposerMenuState<T> extends ComposerMenuAnchor {
  open: boolean;
  items: T[];
  /** Handles the keys that are the menu's, and says whether this was one. */
  keyDown: (e: React.KeyboardEvent) => boolean;
  pick: (item: T) => void;
  hover: (at: number) => void;
  /** Put the highlight back on the first row - typing is a fresh attempt. */
  reset: () => void;
}

export function useComposerMenu<T>(options: {
  /** Empty when the menu should not be up at all. */
  items: T[];
  onPick: (item: T) => void;
  onDismiss: () => void;
}): ComposerMenuState<T> {
  const { items, onPick, onDismiss } = options;
  const id = useId();
  const [index, setIndex] = useState(0);

  // Clamped rather than corrected: the list shrinks under the highlight as the
  // query gets longer, and a highlight past the end would be an empty pick.
  const active = Math.min(index, Math.max(items.length - 1, 0));
  const open = items.length > 0;

  // Taking a row is the end of that menu, so the next one to open starts at the
  // top rather than wherever the last pick happened to leave the highlight.
  const pick = (item: T): void => {
    setIndex(0);
    onPick(item);
  };

  return {
    id,
    open,
    items,
    active,
    pick,
    hover: setIndex,
    reset: () => setIndex(0),
    keyDown: (e) => {
      if (!open) return false;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const delta = e.key === 'ArrowDown' ? 1 : -1;
        setIndex((active + delta + items.length) % items.length);
        return true;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        onDismiss();
        return true;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        pick(items[active]);
        return true;
      }
      return false;
    }
  };
}
