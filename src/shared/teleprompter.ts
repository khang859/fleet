/**
 * Types and pure helpers for the presenter teleprompter overlay.
 *
 * Shared by main (which owns the state and the global hotkeys), the overlay
 * window, and the Settings page. Nothing here may import Node or Electron.
 */

/** The actions a global hotkey can trigger. */
export const TELEPROMPTER_ACTIONS = [
  'next',
  'prev',
  'toggleVisible',
  'toggleLock',
  'resetTimer'
] as const;

export type TeleprompterAction = (typeof TELEPROMPTER_ACTIONS)[number];

export const TELEPROMPTER_ACTION_LABELS: Record<TeleprompterAction, string> = {
  next: 'Next section',
  prev: 'Previous section',
  toggleVisible: 'Show / hide',
  toggleLock: 'Lock / unlock',
  resetTimer: 'Reset timer'
};

export type TeleprompterSettings = {
  /** The notes file on screen. Empty until the user picks one or pastes. */
  notesPath: string;
  fontSize: number;
  /** Background opacity of the panel, 0-1. The text itself stays opaque. */
  opacity: number;
  /** Electron accelerators. An empty string turns that hotkey off. */
  hotkeys: Record<TeleprompterAction, string>;
};

/**
 * Chosen to stay clear of well-known system bindings: Ctrl+Alt+T opens a
 * terminal on Ubuntu, Ctrl+Alt+L locks the screen on GNOME and KDE, and
 * Ctrl+Alt+arrows rotates the display on some Windows Intel drivers. Page
 * Up/Down are the keys a presentation clicker sends, so they are easy to
 * remember.
 */
export const DEFAULT_TELEPROMPTER_HOTKEYS: Record<TeleprompterAction, string> = {
  next: 'Control+Alt+PageDown',
  prev: 'Control+Alt+PageUp',
  toggleVisible: 'Control+Alt+P',
  toggleLock: 'Control+Alt+K',
  resetTimer: 'Control+Alt+0'
};

export const DEFAULT_TELEPROMPTER_SETTINGS: TeleprompterSettings = {
  notesPath: '',
  fontSize: 28,
  opacity: 0.85,
  hotkeys: DEFAULT_TELEPROMPTER_HOTKEYS
};

export const TELEPROMPTER_MIN_FONT_SIZE = 14;
export const TELEPROMPTER_MAX_FONT_SIZE = 72;
export const TELEPROMPTER_FONT_STEP = 2;
export const TELEPROMPTER_MIN_OPACITY = 0.3;
export const TELEPROMPTER_MAX_OPACITY = 1;
export const TELEPROMPTER_OPACITY_STEP = 0.05;

/** File types offered when picking notes, from Settings, the palette, or the overlay. */
export const TELEPROMPTER_NOTES_FILTERS = [
  { name: 'Notes', extensions: ['md', 'markdown', 'txt'] }
];
/** Notes are read whole on every save, so a runaway file is refused up front. */
export const TELEPROMPTER_MAX_NOTES_BYTES = 2 * 1024 * 1024;

export type HotkeyFailure = 'in-use' | 'portal' | 'invalid' | 'duplicate';

export const HOTKEY_FAILURE_TEXT: Record<HotkeyFailure, string> = {
  'in-use': 'Taken by another app or the system',
  portal: 'Refused by the desktop',
  invalid: 'Not a valid shortcut',
  duplicate: 'Already used by another teleprompter shortcut'
};

/** Why every shortcut is refused on some Wayland desktops, said once rather than per shortcut. */
export const PORTAL_HOTKEYS_NOTE =
  'This Wayland desktop does not give Fleet global shortcuts, so they only work in some setups. Step through your notes with the overlay buttons or the command palette instead.';

export type HotkeyStatus = {
  action: TeleprompterAction;
  accelerator: string;
  ok: boolean;
  reason?: HotkeyFailure;
};

/**
 * Everything the overlay draws, pushed by main on every change.
 *
 * Carries the current section rather than the whole script, so a keypress
 * sends a few hundred bytes however long the notes are.
 */
export type TeleprompterState = {
  open: boolean;
  visible: boolean;
  locked: boolean;
  index: number;
  total: number;
  current: string;
  /** First line of the next section, or null on the last one. */
  nextPreview: string | null;
  /** Epoch ms of the first navigation, or null until then. */
  timerStartedAt: number | null;
  fontSize: number;
  opacity: number;
  /** A file name, "Pasted notes", or null when nothing is loaded. */
  sourceLabel: string | null;
  /** Why the notes could not be read, while the last good copy stays up. */
  error: string | null;
  /** Only filled in while the overlay is open, which is when hotkeys exist. */
  hotkeys: HotkeyStatus[];
};

export type TeleprompterCommand =
  | { type: TeleprompterAction }
  | { type: 'open' }
  | { type: 'close' }
  | { type: 'fontSize'; delta: number }
  | { type: 'opacity'; value: number };

export type TeleprompterSource = { kind: 'file'; path: string } | { kind: 'clipboard' };

/** What a window can ask for: a source, or a file picker opened over that window. */
export type TeleprompterSourceRequest = TeleprompterSource | { kind: 'pick' };

/** `cancelled` when the picker was dismissed: nothing changed, and nothing went wrong. */
export type SetSourceResult = { ok: true; cancelled?: true } | { ok: false; error: string };

export function clampFontSize(size: number): number {
  return Math.min(TELEPROMPTER_MAX_FONT_SIZE, Math.max(TELEPROMPTER_MIN_FONT_SIZE, size));
}

export function clampOpacity(opacity: number): number {
  return Math.min(TELEPROMPTER_MAX_OPACITY, Math.max(TELEPROMPTER_MIN_OPACITY, opacity));
}

const MODIFIER_ALIASES: Record<string, string> = {
  ctrl: 'control',
  option: 'alt',
  cmd: 'command',
  commandorcontrol: 'cmdorctrl'
};

/** One spelling per accelerator, so `Ctrl+Alt+P` and `Alt+Control+P` compare equal. */
function normalizeAccelerator(accelerator: string): string {
  return accelerator
    .toLowerCase()
    .split('+')
    .map((part) => MODIFIER_ALIASES[part] ?? part)
    .sort()
    .join('+');
}

/**
 * The actions whose accelerator an earlier action already uses.
 *
 * Only the later one is reported, because that is the one that cannot be
 * registered: the first still works.
 */
export function findAcceleratorConflicts(
  hotkeys: Record<TeleprompterAction, string>
): Set<TeleprompterAction> {
  const seen = new Set<string>();
  const conflicts = new Set<TeleprompterAction>();
  for (const action of TELEPROMPTER_ACTIONS) {
    const accelerator = hotkeys[action];
    if (!accelerator) continue;
    const key = normalizeAccelerator(accelerator);
    if (seen.has(key)) conflicts.add(action);
    else seen.add(key);
  }
  return conflicts;
}

/** `m:ss` under an hour, `h:mm:ss` from there. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, '0');
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${seconds}`;
  return `${minutes}:${seconds}`;
}
