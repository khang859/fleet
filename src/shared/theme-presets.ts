export const TERMINAL_THEME_IDS = [
  'fleet-dark',
  'fleet-light',
  'dracula',
  'nord',
  'tokyo-night',
  'tokyo-night-storm',
  'gruvbox-dark',
  'one-dark',
  'monokai',
  'solarized-dark',
  'catppuccin-mocha',
  'solarized-light',
  'gruvbox-light',
  'catppuccin-latte'
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
  nord: {
    id: 'nord',
    label: 'Nord',
    kind: 'dark',
    background: '#2e3440',
    inactiveBackground: '#292e38',
    xterm: {
      background: '#2e3440',
      foreground: '#d8dee9',
      cursor: '#d8dee9',
      cursorAccent: '#2e3440',
      selectionBackground: '#4c566a',
      black: '#3b4252',
      red: '#bf616a',
      green: '#a3be8c',
      yellow: '#ebcb8b',
      blue: '#81a1c1',
      magenta: '#b48ead',
      cyan: '#88c0d0',
      white: '#e5e9f0',
      brightBlack: '#4c566a',
      brightRed: '#bf616a',
      brightGreen: '#a3be8c',
      brightYellow: '#ebcb8b',
      brightBlue: '#81a1c1',
      brightMagenta: '#b48ead',
      brightCyan: '#8fbcbb',
      brightWhite: '#eceff4'
    }
  },
  'tokyo-night': {
    id: 'tokyo-night',
    label: 'Tokyo Night',
    kind: 'dark',
    background: '#1a1b26',
    inactiveBackground: '#16161f',
    xterm: {
      background: '#1a1b26',
      foreground: '#c0caf5',
      cursor: '#c0caf5',
      cursorAccent: '#15161e',
      selectionBackground: '#33467c',
      black: '#15161e',
      red: '#f7768e',
      green: '#9ece6a',
      yellow: '#e0af68',
      blue: '#7aa2f7',
      magenta: '#bb9af7',
      cyan: '#7dcfff',
      white: '#a9b1d6',
      brightBlack: '#414868',
      brightRed: '#f7768e',
      brightGreen: '#9ece6a',
      brightYellow: '#e0af68',
      brightBlue: '#7aa2f7',
      brightMagenta: '#bb9af7',
      brightCyan: '#7dcfff',
      brightWhite: '#c0caf5'
    }
  },
  'tokyo-night-storm': {
    id: 'tokyo-night-storm',
    label: 'Tokyo Night Storm',
    kind: 'dark',
    background: '#24283b',
    inactiveBackground: '#1f2333',
    xterm: {
      background: '#24283b',
      foreground: '#c0caf5',
      cursor: '#c0caf5',
      cursorAccent: '#1d202f',
      selectionBackground: '#364a82',
      black: '#1d202f',
      red: '#f7768e',
      green: '#9ece6a',
      yellow: '#e0af68',
      blue: '#7aa2f7',
      magenta: '#bb9af7',
      cyan: '#7dcfff',
      white: '#a9b1d6',
      brightBlack: '#4e5575',
      brightRed: '#f7768e',
      brightGreen: '#9ece6a',
      brightYellow: '#e0af68',
      brightBlue: '#7aa2f7',
      brightMagenta: '#bb9af7',
      brightCyan: '#7dcfff',
      brightWhite: '#c0caf5'
    }
  },
  'gruvbox-dark': {
    id: 'gruvbox-dark',
    label: 'Gruvbox Dark',
    kind: 'dark',
    background: '#282828',
    inactiveBackground: '#1d2021',
    xterm: {
      background: '#282828',
      foreground: '#ebdbb2',
      cursor: '#ebdbb2',
      cursorAccent: '#282828',
      selectionBackground: '#665c54',
      black: '#282828',
      red: '#cc241d',
      green: '#98971a',
      yellow: '#d79921',
      blue: '#458588',
      magenta: '#b16286',
      cyan: '#689d6a',
      white: '#a89984',
      brightBlack: '#928374',
      brightRed: '#fb4934',
      brightGreen: '#b8bb26',
      brightYellow: '#fabd2f',
      brightBlue: '#83a598',
      brightMagenta: '#d3869b',
      brightCyan: '#8ec07c',
      brightWhite: '#ebdbb2'
    }
  },
  'one-dark': {
    id: 'one-dark',
    label: 'One Dark',
    kind: 'dark',
    background: '#282c34',
    inactiveBackground: '#21252b',
    xterm: {
      background: '#282c34',
      foreground: '#abb2bf',
      cursor: '#abb2bf',
      cursorAccent: '#282c34',
      selectionBackground: '#323844',
      black: '#282c34',
      red: '#e06c75',
      green: '#98c379',
      yellow: '#e5c07b',
      blue: '#61afef',
      magenta: '#c678dd',
      cyan: '#56b6c2',
      white: '#abb2bf',
      brightBlack: '#5c6370',
      brightRed: '#e06c75',
      brightGreen: '#98c379',
      brightYellow: '#e5c07b',
      brightBlue: '#61afef',
      brightMagenta: '#c678dd',
      brightCyan: '#56b6c2',
      brightWhite: '#ffffff'
    }
  },
  monokai: {
    id: 'monokai',
    label: 'Monokai',
    kind: 'dark',
    background: '#272822',
    inactiveBackground: '#21221d',
    xterm: {
      background: '#272822',
      foreground: '#fdfff1',
      cursor: '#c0c1b5',
      cursorAccent: '#272822',
      selectionBackground: '#57584f',
      black: '#272822',
      red: '#f92672',
      green: '#a6e22e',
      yellow: '#e6db74',
      blue: '#fd971f',
      magenta: '#ae81ff',
      cyan: '#66d9ef',
      white: '#fdfff1',
      brightBlack: '#6e7066',
      brightRed: '#f92672',
      brightGreen: '#a6e22e',
      brightYellow: '#e6db74',
      brightBlue: '#fd971f',
      brightMagenta: '#ae81ff',
      brightCyan: '#66d9ef',
      brightWhite: '#fdfff1'
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
  },
  'solarized-light': {
    id: 'solarized-light',
    label: 'Solarized Light',
    kind: 'light',
    background: '#fdf6e3',
    inactiveBackground: '#f4eed5',
    xterm: {
      background: '#fdf6e3',
      foreground: '#657b83',
      cursor: '#657b83',
      cursorAccent: '#fdf6e3',
      selectionBackground: '#eee8d5',
      black: '#073642',
      red: '#dc322f',
      green: '#859900',
      yellow: '#b58900',
      blue: '#268bd2',
      magenta: '#d33682',
      cyan: '#2aa198',
      white: '#bbb5a2',
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
  'gruvbox-light': {
    id: 'gruvbox-light',
    label: 'Gruvbox Light',
    kind: 'light',
    background: '#fbf1c7',
    inactiveBackground: '#f2e5bc',
    xterm: {
      background: '#fbf1c7',
      foreground: '#3c3836',
      cursor: '#3c3836',
      cursorAccent: '#fbf1c7',
      selectionBackground: '#d5c4a1',
      black: '#fbf1c7',
      red: '#cc241d',
      green: '#98971a',
      yellow: '#d79921',
      blue: '#458588',
      magenta: '#b16286',
      cyan: '#689d6a',
      white: '#7c6f64',
      brightBlack: '#928374',
      brightRed: '#9d0006',
      brightGreen: '#79740e',
      brightYellow: '#b57614',
      brightBlue: '#076678',
      brightMagenta: '#8f3f71',
      brightCyan: '#427b58',
      brightWhite: '#3c3836'
    }
  },
  'catppuccin-latte': {
    id: 'catppuccin-latte',
    label: 'Catppuccin Latte',
    kind: 'light',
    background: '#eff1f5',
    inactiveBackground: '#e6e9ef',
    xterm: {
      background: '#eff1f5',
      foreground: '#4c4f69',
      cursor: '#dc8a78',
      cursorAccent: '#eff1f5',
      selectionBackground: '#acb0be',
      black: '#5c5f77',
      red: '#d20f39',
      green: '#40a02b',
      yellow: '#df8e1d',
      blue: '#1e66f5',
      magenta: '#ea76cb',
      cyan: '#179299',
      white: '#acb0be',
      brightBlack: '#6c6f85',
      brightRed: '#de293e',
      brightGreen: '#49af3d',
      brightYellow: '#eea02d',
      brightBlue: '#456eff',
      brightMagenta: '#fe85d8',
      brightCyan: '#2d9fa8',
      brightWhite: '#bcc0cc'
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
