type KeyInput = Pick<KeyboardEvent, 'code' | 'key' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'>;

const NAMED_CODES: Record<string, string> = {
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  Home: 'Home',
  End: 'End',
  Insert: 'Insert',
  Delete: 'Delete',
  Backspace: 'Backspace',
  Enter: 'Enter',
  Tab: 'Tab',
  Space: 'Space',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backquote: '`'
};

const MODIFIER_KEYS = new Set(['Control', 'Alt', 'Shift', 'Meta', 'AltGraph', 'OS']);

/**
 * The key part of an accelerator, from the physical key.
 *
 * Read from `code`, not `key`: with Alt held, macOS reports Alt+P as "π", and
 * Shift changes digits into symbols, but Electron wants the key itself.
 */
function keyName(code: string): string | null {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (/^Numpad\d$/.test(code)) return `num${code.slice(6)}`;
  if (/^F\d{1,2}$/.test(code)) return code;
  return NAMED_CODES[code] ?? null;
}

/**
 * Turn a key press into an Electron accelerator, or null while only modifiers
 * are down or the combination cannot be a global shortcut.
 *
 * At least one of Control, Alt or Command/Super is required: a system-wide
 * shortcut without one would take the key away from every other app.
 */
export function keyEventToAccelerator(e: KeyInput, platform: string): string | null {
  if (MODIFIER_KEYS.has(e.key)) return null;
  const key = keyName(e.code);
  if (!key) return null;
  if (!e.ctrlKey && !e.altKey && !e.metaKey) return null;
  const parts: string[] = [];
  if (e.ctrlKey) parts.push('Control');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  if (e.metaKey) parts.push(platform === 'darwin' ? 'Command' : 'Super');
  parts.push(key);
  return parts.join('+');
}

const MAC_SYMBOLS: Record<string, string> = {
  Control: '⌃',
  Ctrl: '⌃',
  Alt: '⌥',
  Option: '⌥',
  Shift: '⇧',
  Command: '⌘',
  Cmd: '⌘'
};

const KEY_LABELS: Record<string, string> = {
  PageUp: 'PgUp',
  PageDown: 'PgDn',
  Left: '←',
  Right: '→',
  Up: '↑',
  Down: '↓'
};

/** How an accelerator reads on a key cap: symbols on macOS, words joined by + elsewhere. */
export function formatAccelerator(accelerator: string, platform: string): string {
  const parts = accelerator.split('+').map((part) => KEY_LABELS[part] ?? part);
  if (platform === 'darwin') return parts.map((part) => MAC_SYMBOLS[part] ?? part).join('');
  return parts.map((part) => (part === 'Control' ? 'Ctrl' : part)).join('+');
}
