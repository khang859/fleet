export const TERMINAL_THEME_IDS = [
  'fleet-dark',
  'fleet-light',
  'dracula',
  'solarized-dark',
  'catppuccin-mocha'
] as const;

export type TerminalThemeId = (typeof TERMINAL_THEME_IDS)[number];

export type TerminalThemeColors = {
  foreground?: string;
  background?: string;
  cursor?: string;
  cursorAccent?: string;
  selectionBackground?: string;
  selectionForeground?: string;
  selectionInactiveBackground?: string;
  black?: string;
  red?: string;
  green?: string;
  yellow?: string;
  blue?: string;
  magenta?: string;
  cyan?: string;
  white?: string;
  brightBlack?: string;
  brightRed?: string;
  brightGreen?: string;
  brightYellow?: string;
  brightBlue?: string;
  brightMagenta?: string;
  brightCyan?: string;
  brightWhite?: string;
};

export type TerminalThemeDefinition = {
  id: TerminalThemeId;
  label: string;
  kind: 'dark' | 'light';
  background: string;
  inactiveBackground: string;
  xterm: TerminalThemeColors;
};

export const DEFAULT_TERMINAL_THEME_ID: TerminalThemeId = 'fleet-dark';

export const TERMINAL_THEMES: Record<TerminalThemeId, TerminalThemeDefinition> = {
  'fleet-dark': {
    id: 'fleet-dark',
    label: 'Fleet Dark',
    kind: 'dark',
    background: '#151515',
    inactiveBackground: '#131313',
    xterm: {
      background: '#151515',
      foreground: '#e4e4e4',
      cursor: '#e4e4e4',
      cursorAccent: '#0a0a0a',
      selectionBackground: '#3a3d41',
      black: '#0a0a0a',
      red: '#ff5c57',
      green: '#5af78e',
      yellow: '#f3f99d',
      blue: '#57c7ff',
      magenta: '#ff6ac1',
      cyan: '#9aedfe',
      white: '#f1f1f0',
      brightBlack: '#686868',
      brightRed: '#ff5c57',
      brightGreen: '#5af78e',
      brightYellow: '#f3f99d',
      brightBlue: '#57c7ff',
      brightMagenta: '#ff6ac1',
      brightCyan: '#9aedfe',
      brightWhite: '#f1f1f0'
    }
  },
  'fleet-light': {
    id: 'fleet-light',
    label: 'Fleet Light',
    kind: 'light',
    background: '#f8fafc',
    inactiveBackground: '#eef2f7',
    xterm: {
      background: '#f8fafc',
      foreground: '#1f2937',
      cursor: '#1f2937',
      cursorAccent: '#f8fafc',
      selectionBackground: '#cbd5e1',
      black: '#1f2937',
      red: '#dc2626',
      green: '#16a34a',
      yellow: '#ca8a04',
      blue: '#2563eb',
      magenta: '#c026d3',
      cyan: '#0891b2',
      white: '#e5e7eb',
      brightBlack: '#6b7280',
      brightRed: '#ef4444',
      brightGreen: '#22c55e',
      brightYellow: '#eab308',
      brightBlue: '#3b82f6',
      brightMagenta: '#d946ef',
      brightCyan: '#06b6d4',
      brightWhite: '#ffffff'
    }
  },
  dracula: {
    id: 'dracula',
    label: 'Dracula',
    kind: 'dark',
    background: '#282a36',
    inactiveBackground: '#242631',
    xterm: {
      background: '#282a36',
      foreground: '#f8f8f2',
      cursor: '#f8f8f2',
      cursorAccent: '#282a36',
      selectionBackground: '#44475a',
      black: '#21222c',
      red: '#ff5555',
      green: '#50fa7b',
      yellow: '#f1fa8c',
      blue: '#bd93f9',
      magenta: '#ff79c6',
      cyan: '#8be9fd',
      white: '#f8f8f2',
      brightBlack: '#6272a4',
      brightRed: '#ff6e6e',
      brightGreen: '#69ff94',
      brightYellow: '#ffffa5',
      brightBlue: '#d6acff',
      brightMagenta: '#ff92df',
      brightCyan: '#a4ffff',
      brightWhite: '#ffffff'
    }
  },
  'solarized-dark': {
    id: 'solarized-dark',
    label: 'Solarized Dark',
    kind: 'dark',
    background: '#002b36',
    inactiveBackground: '#00242d',
    xterm: {
      background: '#002b36',
      foreground: '#839496',
      cursor: '#93a1a1',
      cursorAccent: '#002b36',
      selectionBackground: '#073642',
      black: '#073642',
      red: '#dc322f',
      green: '#859900',
      yellow: '#b58900',
      blue: '#268bd2',
      magenta: '#d33682',
      cyan: '#2aa198',
      white: '#eee8d5',
      brightBlack: '#002b36',
      brightRed: '#cb4b16',
      brightGreen: '#586e75',
      brightYellow: '#657b83',
      brightBlue: '#839496',
      brightMagenta: '#6c71c4',
      brightCyan: '#93a1a1',
      brightWhite: '#fdf6e3'
    }
  },
  'catppuccin-mocha': {
    id: 'catppuccin-mocha',
    label: 'Catppuccin Mocha',
    kind: 'dark',
    background: '#1e1e2e',
    inactiveBackground: '#181825',
    xterm: {
      background: '#1e1e2e',
      foreground: '#cdd6f4',
      cursor: '#f5e0dc',
      cursorAccent: '#1e1e2e',
      selectionBackground: '#45475a',
      black: '#45475a',
      red: '#f38ba8',
      green: '#a6e3a1',
      yellow: '#f9e2af',
      blue: '#89b4fa',
      magenta: '#f5c2e7',
      cyan: '#94e2d5',
      white: '#bac2de',
      brightBlack: '#585b70',
      brightRed: '#f38ba8',
      brightGreen: '#a6e3a1',
      brightYellow: '#f9e2af',
      brightBlue: '#89b4fa',
      brightMagenta: '#f5c2e7',
      brightCyan: '#94e2d5',
      brightWhite: '#a6adc8'
    }
  }
};

export const ACCENT_COLOR_IDS = ['blue', 'teal', 'purple', 'rose', 'amber', 'emerald'] as const;

export type AccentColorId = (typeof ACCENT_COLOR_IDS)[number];

export type AccentColorDefinition = {
  id: AccentColorId;
  label: string;
  value: string;
  hover: string;
};

export const DEFAULT_ACCENT_COLOR_ID: AccentColorId = 'blue';

export function isTerminalThemeId(value: string): value is TerminalThemeId {
  return Object.prototype.hasOwnProperty.call(TERMINAL_THEMES, value);
}

export const ACCENT_COLORS: Record<AccentColorId, AccentColorDefinition> = {
  blue: { id: 'blue', label: 'Blue', value: '#3b82f6', hover: '#60a5fa' },
  teal: { id: 'teal', label: 'Teal', value: '#14b8a6', hover: '#2dd4bf' },
  purple: { id: 'purple', label: 'Purple', value: '#a855f7', hover: '#c084fc' },
  rose: { id: 'rose', label: 'Rose', value: '#f43f5e', hover: '#fb7185' },
  amber: { id: 'amber', label: 'Amber', value: '#f59e0b', hover: '#fbbf24' },
  emerald: { id: 'emerald', label: 'Emerald', value: '#10b981', hover: '#34d399' }
};

export function isAccentColorId(value: string): value is AccentColorId {
  return Object.prototype.hasOwnProperty.call(ACCENT_COLORS, value);
}
