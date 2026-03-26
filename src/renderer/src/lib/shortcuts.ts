export const PLATFORM: 'mac' | 'other' =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? 'mac' : 'other';

export type KeyCombo = {
  key: string;
  meta?: boolean;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
};

export type ShortcutDef = {
  id: string;
  label: string;
  mac: KeyCombo;
  other: KeyCombo;
};

export const ALL_SHORTCUTS: ShortcutDef[] = [
  {
    id: 'new-tab',
    label: 'New tab',
    mac: { key: 't', meta: true },
    other: { key: 't', ctrl: true }
  },
  {
    id: 'close-pane',
    label: 'Close pane',
    mac: { key: 'w', meta: true },
    other: { key: 'W', ctrl: true, shift: true }
  },
  {
    id: 'split-right',
    label: 'Split right',
    mac: { key: 'd', meta: true },
    other: { key: 'D', ctrl: true, shift: true }
  },
  {
    id: 'split-down',
    label: 'Split down',
    mac: { key: 'D', meta: true, shift: true },
    other: { key: 'D', ctrl: true, shift: true, alt: true }
  },
  {
    id: 'navigate-prev',
    label: 'Previous pane',
    mac: { key: '[', meta: true },
    other: { key: '[', ctrl: true, shift: true }
  },
  {
    id: 'navigate-next',
    label: 'Next pane',
    mac: { key: ']', meta: true },
    other: { key: ']', ctrl: true, shift: true }
  },
  {
    id: 'cycle-tab-next',
    label: 'Next tab',
    mac: { key: 'Tab', ctrl: true },
    other: { key: 'Tab', ctrl: true }
  },
  {
    id: 'cycle-tab-prev',
    label: 'Previous tab',
    mac: { key: 'Tab', ctrl: true, shift: true },
    other: { key: 'Tab', ctrl: true, shift: true }
  },
  {
    id: 'search',
    label: 'Search in pane',
    mac: { key: 'f', meta: true },
    other: { key: 'F', ctrl: true, shift: true }
  },
  {
    id: 'visualizer',
    label: 'Toggle visualizer',
    mac: { key: 'V', meta: true, shift: true },
    other: { key: 'V', ctrl: true, shift: true }
  },
  {
    id: 'settings',
    label: 'Settings',
    mac: { key: ',', meta: true },
    other: { key: ',', ctrl: true }
  },
  {
    id: 'shortcuts',
    label: 'Show shortcuts',
    mac: { key: '/', meta: true },
    other: { key: '/', ctrl: true }
  },
  {
    id: 'rename-tab',
    label: 'Rename tab',
    mac: { key: 'F2' },
    other: { key: 'F2' }
  },
  {
    id: 'command-palette',
    label: 'Command palette',
    mac: { key: 'P', meta: true, shift: true },
    other: { key: 'P', ctrl: true, shift: true }
  },
  {
    id: 'git-changes',
    label: 'Git Changes',
    mac: { key: 'g', meta: true, shift: true },
    other: { key: 'G', ctrl: true, shift: true }
  },
  {
    id: 'open-file',
    label: 'Open file dialog',
    mac: { key: 'o', meta: true },
    other: { key: 'o', ctrl: true }
  },
  {
    id: 'quick-open',
    label: 'Quick open',
    mac: { key: 'p', meta: true },
    other: { key: 'p', ctrl: true }
  },
  {
    id: 'file-search',
    label: 'Search files on disk',
    mac: { key: 'O', meta: true, shift: true },
    other: { key: 'O', ctrl: true, shift: true }
  },
  {
    id: 'clipboard-history',
    label: 'Clipboard history',
    mac: { key: 'H', meta: true, shift: true },
    other: { key: 'H', ctrl: true, shift: true }
  }
];

export function matchesShortcut(e: KeyboardEvent, def: ShortcutDef): boolean {
  const combo = PLATFORM === 'mac' ? def.mac : def.other;
  if (e.key !== combo.key && e.key.toLowerCase() !== combo.key.toLowerCase()) return false;
  // For shifted keys, e.key is uppercase — also match case-insensitively
  if (combo.shift && !e.shiftKey) return false;
  if (!combo.shift && e.shiftKey && combo.key !== 'Tab') return false;
  if (combo.meta && !e.metaKey) return false;
  if (!combo.meta && e.metaKey) return false;
  if (combo.ctrl && !e.ctrlKey) return false;
  if (!combo.ctrl && e.ctrlKey) return false;
  if (combo.alt && !e.altKey) return false;
  if (!combo.alt && e.altKey) return false;
  return true;
}

function modLabel(platform: 'mac' | 'other'): string {
  return platform === 'mac' ? 'Cmd' : 'Ctrl';
}

export function formatShortcut(def: ShortcutDef): string {
  const combo = PLATFORM === 'mac' ? def.mac : def.other;
  const parts: string[] = [];
  if (combo.ctrl) parts.push('Ctrl');
  if (combo.meta) parts.push(modLabel(PLATFORM));
  if (combo.alt) parts.push('Alt');
  if (combo.shift) parts.push('Shift');
  // Display key nicely
  const keyLabel = combo.key === 'Tab' ? 'Tab' : combo.key.toUpperCase();
  parts.push(keyLabel);
  return parts.join('+');
}

export function getShortcut(id: string): ShortcutDef | undefined {
  return ALL_SHORTCUTS.find((s) => s.id === id);
}
