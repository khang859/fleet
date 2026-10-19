import type { Reading } from '../../store/bridge-store';
import { inTextField } from './use-bridge-queue';

/** What a key does in the Bridge queue and reader. */
export type QueueKey =
  | 'next'
  | 'previous'
  | 'read'
  | 'close'
  | 'approve'
  | 'deny'
  | 'change'
  | 'reply';

const KEYS = new Map<string, QueueKey>([
  ['j', 'next'],
  ['k', 'previous'],
  ['Enter', 'read'],
  ['Escape', 'close'],
  ['a', 'approve'],
  ['d', 'deny'],
  ['c', 'change'],
  ['r', 'reply']
]);

/** The key as the client presses it, for hints and `aria-keyshortcuts`. */
export const KEY_NAME: Record<QueueKey, string> = {
  next: 'J',
  previous: 'K',
  read: 'Enter',
  close: 'Escape',
  approve: 'A',
  deny: 'D',
  change: 'C',
  reply: 'R'
};

/** The key as a hint shows it. */
export function keyHint(key: QueueKey): string {
  return key === 'close' ? 'Esc' : KEY_NAME[key];
}

/**
 * What a key press does in the queue or the reader: nothing in a text field,
 * where the letter is the field's own, and nothing with a modifier held.
 */
export function queueKey(e: {
  key: string;
  target: EventTarget | null;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  defaultPrevented: boolean;
}): QueueKey | null {
  if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return null;
  if (inTextField(e.target)) return null;
  return KEYS.get(e.key) ?? null;
}

/** Marks the button a key presses, and names the key for screen readers. */
export function keyProps(key: QueueKey): { 'data-key': QueueKey; 'aria-keyshortcuts': string } {
  return { 'data-key': key, 'aria-keyshortcuts': KEY_NAME[key] };
}

/**
 * The Bridge's keys, on its root: they act only with focus in the queue
 * (`data-queue-scope="queue"`) or the reader (`"reader"`). A, D, C and R
 * press the item's own button for the key, so a disabled one stays disabled;
 * R focuses a text box instead where that is the item's way to reply.
 */
export function onQueueKey(
  e: React.KeyboardEvent<HTMLElement>,
  reading: Reading | null,
  read: (key: string | null) => void
): void {
  const key = queueKey(e);
  const target = e.target;
  if (key === null || !(target instanceof HTMLElement)) return;
  const scope = target.closest('[data-queue-scope]');
  if (scope === null) return;
  const done =
    scope.getAttribute('data-queue-scope') === 'reader'
      ? readerKey(key, scope, reading, read, e.currentTarget)
      : queueItemKey(key, target, e.currentTarget, reading, read);
  if (done) e.preventDefault();
}

function readerKey(
  key: QueueKey,
  reader: Element,
  reading: Reading | null,
  read: (key: string | null) => void,
  root: HTMLElement
): boolean {
  if (key === 'read') return false;
  if (key === 'close') {
    if (reading === null) return false;
    read(null);
    // The reader is gone after this render; the item's card takes focus.
    requestAnimationFrame(() => focusItem(root, reading.key));
    return true;
  }
  return press(reader.querySelector(`[data-key="${key}"]`));
}

function queueItemKey(
  key: QueueKey,
  target: HTMLElement,
  root: HTMLElement,
  reading: Reading | null,
  read: (key: string | null) => void
): boolean {
  const item = target.closest<HTMLElement>('[data-item]');
  switch (key) {
    case 'next':
    case 'previous':
      return move(root, item, key === 'next' ? 1 : -1);
    case 'read':
      // Enter on a button inside the card presses that button.
      if (item === null || item !== target) return false;
      read(item.dataset.item ?? null);
      return true;
    case 'close':
      if (reading === null) return false;
      read(null);
      return true;
    case 'approve':
    case 'deny':
    case 'change':
    case 'reply':
      return item !== null && pressIn(root, item, key);
  }
}

/** Moves focus to the next or previous card in the queue, or the first. */
function move(root: HTMLElement, from: HTMLElement | null, by: 1 | -1): boolean {
  const items = [...root.querySelectorAll<HTMLElement>('[data-item]')];
  if (items.length === 0) return false;
  const at = from === null ? -1 : items.indexOf(from);
  const next = at < 0 ? items[0] : items[Math.min(items.length - 1, Math.max(0, at + by))];
  next.focus();
  return true;
}

/**
 * Presses the card's button for the key. A decision takes the card out of
 * the queue, so focus goes on to the card that takes its place.
 */
function pressIn(root: HTMLElement, item: HTMLElement, key: QueueKey): boolean {
  const at = [...root.querySelectorAll('[data-item]')].indexOf(item);
  if (!press(item.querySelector(`[data-key="${key}"]`))) return false;
  requestAnimationFrame(() => {
    if (item.isConnected) return;
    const items = root.querySelectorAll<HTMLElement>('[data-item]');
    if (items.length > 0) items[Math.min(at, items.length - 1)].focus();
  });
  return true;
}

function focusItem(root: HTMLElement, key: string): void {
  root.querySelector<HTMLElement>(`[data-item="${CSS.escape(key)}"]`)?.focus();
}

/** Clicks an enabled button, or focuses a text box; false when there is nothing to press. */
function press(el: Element | null): boolean {
  if (el instanceof HTMLButtonElement) {
    if (el.disabled) return false;
    el.click();
    return true;
  }
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    el.focus();
    return true;
  }
  return false;
}
