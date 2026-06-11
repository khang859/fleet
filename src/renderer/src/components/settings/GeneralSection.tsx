import { useEffect, useState } from 'react';
import { useSettingsStore } from '../../store/settings-store';
import { useShellProfilesStore } from '../../store/shell-profiles-store';
import { useDebouncedCallback } from '../../hooks/use-debounced-callback';
import { SettingRow } from './SettingRow';
import { TerminalBackgroundSettings } from './TerminalBackgroundSettings';
import type { FontSelection } from '../../../../shared/types';
import { resolveFontFamily } from '../../../../shared/types';
import {
  ACCENT_COLORS,
  TERMINAL_THEMES,
  isAppThemeSelection,
  isTerminalThemeId
} from '../../../../shared/theme-presets';
import { normalizeAppTheme } from '../../lib/theme';

const BUNDLED_FONTS: Array<{ label: string; selection: FontSelection }> = [
  { label: 'JetBrains Mono Nerd', selection: { type: 'bundled', name: 'JetBrains Mono Nerd Font' } }
];

const TERMINAL_THEME_OPTIONS = Object.values(TERMINAL_THEMES);
const DARK_THEME_OPTIONS = TERMINAL_THEME_OPTIONS.filter((theme) => theme.kind === 'dark');
const LIGHT_THEME_OPTIONS = TERMINAL_THEME_OPTIONS.filter((theme) => theme.kind === 'light');
const ACCENT_COLOR_OPTIONS = Object.values(ACCENT_COLORS);

function parseFontSelection(fontFamily: string): {
  mode: 'bundled' | 'custom';
  bundledIndex: number;
  customValue: string;
} {
  for (let i = 0; i < BUNDLED_FONTS.length; i++) {
    const resolved = resolveFontFamily(BUNDLED_FONTS[i].selection);
    if (fontFamily === resolved) {
      return { mode: 'bundled', bundledIndex: i, customValue: '' };
    }
  }
  // Extract the first font name from the family string (strip fallbacks)
  const custom = fontFamily.replace(/, ?Symbols Nerd Font.*$/, '').replace(/, ?monospace.*$/, '');
  return { mode: 'custom', bundledIndex: -1, customValue: custom || fontFamily };
}

function FontFamilyPicker({
  fontFamily,
  onChange
}: {
  fontFamily: string;
  onChange: (v: string) => void;
}): React.JSX.Element {
  const parsed = parseFontSelection(fontFamily);
  const [customValue, setCustomValue] = useState(parsed.customValue);

  const debouncedOnChange = useDebouncedCallback((value: string) => {
    onChange(resolveFontFamily({ type: 'custom', name: value || 'monospace' }));
  }, 300);

  return (
    <div className="space-y-2">
      <span className="text-sm text-fleet-text-secondary">Font Family</span>
      <div className="space-y-1.5">
        {BUNDLED_FONTS.map((font, i) => {
          const isSelected = parsed.mode === 'bundled' && parsed.bundledIndex === i;
          return (
            <label
              key={font.label}
              className={`flex items-center gap-2.5 px-3 py-2 rounded cursor-pointer border transition-colors ${
                isSelected
                  ? 'fleet-accent-border-soft fleet-accent-bg-soft'
                  : 'border-fleet-border-strong bg-fleet-surface-2 hover:border-fleet-text-subtle'
              }`}
            >
              <input
                type="radio"
                name="fontFamily"
                checked={isSelected}
                onChange={() => onChange(resolveFontFamily(font.selection))}
                className="fleet-accent-input"
              />
              <span
                className="text-sm text-fleet-text"
                style={{ fontFamily: resolveFontFamily(font.selection) }}
              >
                {font.label}
              </span>
              <span className="text-xs text-fleet-text-subtle ml-auto">bundled</span>
            </label>
          );
        })}
        <label
          className={`flex items-center gap-2.5 px-3 py-2 rounded cursor-pointer border transition-colors ${
            parsed.mode === 'custom'
              ? 'fleet-accent-border-soft fleet-accent-bg-soft'
              : 'border-fleet-border-strong bg-fleet-surface-2 hover:border-fleet-text-subtle'
          }`}
        >
          <input
            type="radio"
            name="fontFamily"
            checked={parsed.mode === 'custom'}
            onChange={() => {
              const val = customValue || 'monospace';
              onChange(resolveFontFamily({ type: 'custom', name: val }));
            }}
            className="fleet-accent-input"
          />
          <span className="text-sm text-fleet-text-secondary">Custom:</span>
          <input
            type="text"
            value={parsed.mode === 'custom' ? customValue : ''}
            placeholder="System font name..."
            onFocus={() => {
              if (parsed.mode !== 'custom') {
                const val = customValue || 'monospace';
                setCustomValue(val);
                onChange(resolveFontFamily({ type: 'custom', name: val }));
              }
            }}
            onChange={(e) => {
              setCustomValue(e.target.value);
              debouncedOnChange(e.target.value);
            }}
            className="bg-fleet-surface text-fleet-text text-sm rounded px-2 py-0.5 flex-1 border border-fleet-border-strong disabled:opacity-40"
            disabled={parsed.mode !== 'custom'}
          />
        </label>
      </div>
      {/* Preview */}
      <div
        className="text-sm text-fleet-text-muted px-3 py-1.5 bg-fleet-surface-2/50 rounded border border-fleet-border"
        style={{ fontFamily }}
      >
        ABCDEFG abcdefg 0123456789 {'\ue0b0'} {'\ue0b2'} {'\uf113'} {'\uf09b'}
      </div>
    </div>
  );
}

export function GeneralSection(): React.JSX.Element {
  const { settings, updateSettings } = useSettingsStore();
  const shellProfiles = useShellProfilesStore((s) => s.profiles);

  // Profiles normally load at app startup; ensure they're present if Settings is
  // the first thing to need them.
  useEffect(() => {
    void useShellProfilesStore.getState().load();
  }, []);

  const handleDefaultProfileChange = async (profileId: string): Promise<void> => {
    await updateSettings({ general: { defaultShellProfileId: profileId } });
    // Re-resolve the default so new tabs honor the change without a restart.
    await useShellProfilesStore.getState().refresh();
  };

  const [localShell, setLocalShell] = useState(settings?.general.defaultShell ?? '');
  const [localFontSize, setLocalFontSize] = useState(
    settings?.general.fontSize !== undefined ? String(settings.general.fontSize) : '14'
  );
  const [localScrollback, setLocalScrollback] = useState(
    settings?.general.scrollbackSize !== undefined
      ? String(settings.general.scrollbackSize)
      : '10000'
  );

  const debouncedSaveShell = useDebouncedCallback((value: string) => {
    void updateSettings({ general: { defaultShell: value } });
  }, 300);

  const debouncedSaveFontSize = useDebouncedCallback((value: string) => {
    void updateSettings({
      general: { fontSize: parseInt(value) || 14 }
    });
  }, 300);

  const debouncedSaveScrollback = useDebouncedCallback((value: string) => {
    void updateSettings({
      general: { scrollbackSize: parseInt(value) || 10000 }
    });
  }, 300);

  if (!settings) return <></>;

  return (
    <div className="space-y-4">
      <SettingRow label="Default Shell">
        <input
          type="text"
          value={localShell || '(auto-detect)'}
          onChange={(e) => {
            setLocalShell(e.target.value);
            debouncedSaveShell(e.target.value);
          }}
          placeholder="(auto-detect)"
          className="bg-fleet-surface-2 text-fleet-text text-sm rounded px-2 py-1 w-48 border border-fleet-border-strong"
        />
      </SettingRow>
      {shellProfiles.length > 0 && (
        <SettingRow label="Default Profile">
          <select
            value={settings.general.defaultShellProfileId}
            onChange={(e) => {
              void handleDefaultProfileChange(e.target.value);
            }}
            className="bg-fleet-surface-2 text-fleet-text text-sm rounded px-2 py-1 border border-fleet-border-strong"
          >
            <option value="">(auto-detect)</option>
            {shellProfiles.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.label}
              </option>
            ))}
          </select>
        </SettingRow>
      )}
      <SettingRow label="Font Size">
        <input
          type="number"
          value={localFontSize}
          onChange={(e) => {
            setLocalFontSize(e.target.value);
            debouncedSaveFontSize(e.target.value);
          }}
          className="bg-fleet-surface-2 text-fleet-text text-sm rounded px-2 py-1 w-20 border border-fleet-border-strong"
        />
      </SettingRow>
      <FontFamilyPicker
        fontFamily={settings.general.fontFamily}
        onChange={(fontFamily) => {
          void updateSettings({ general: { fontFamily } });
        }}
      />
      <SettingRow label="Scrollback Lines">
        <input
          type="number"
          value={localScrollback}
          onChange={(e) => {
            setLocalScrollback(e.target.value);
            debouncedSaveScrollback(e.target.value);
          }}
          className="bg-fleet-surface-2 text-fleet-text text-sm rounded px-2 py-1 w-24 border border-fleet-border-strong"
        />
      </SettingRow>
      <SettingRow label="App Theme">
        <select
          value={normalizeAppTheme(settings.general.theme)}
          onChange={(e) => {
            const { value } = e.target;
            if (isAppThemeSelection(value)) {
              void updateSettings({ general: { theme: value } });
            }
          }}
          className="bg-fleet-surface-2 text-fleet-text text-sm rounded px-2 py-1 border border-fleet-border-strong"
        >
          <optgroup label="Mode">
            <option value="system">System (follow OS)</option>
            <option value="match-terminal">Match Terminal Theme</option>
          </optgroup>
          <optgroup label="Dark">
            {DARK_THEME_OPTIONS.map((theme) => (
              <option key={theme.id} value={theme.id}>
                {theme.label}
              </option>
            ))}
          </optgroup>
          <optgroup label="Light">
            {LIGHT_THEME_OPTIONS.map((theme) => (
              <option key={theme.id} value={theme.id}>
                {theme.label}
              </option>
            ))}
          </optgroup>
        </select>
      </SettingRow>
      <SettingRow label="Terminal Theme">
        <select
          value={settings.general.terminalTheme}
          onChange={(e) => {
            const { value } = e.target;
            if (isTerminalThemeId(value)) {
              void updateSettings({ general: { terminalTheme: value } });
            }
          }}
          className="bg-fleet-surface-2 text-fleet-text text-sm rounded px-2 py-1 border border-fleet-border-strong"
        >
          <optgroup label="Dark">
            {DARK_THEME_OPTIONS.map((theme) => (
              <option key={theme.id} value={theme.id}>
                {theme.label}
              </option>
            ))}
          </optgroup>
          <optgroup label="Light">
            {LIGHT_THEME_OPTIONS.map((theme) => (
              <option key={theme.id} value={theme.id}>
                {theme.label}
              </option>
            ))}
          </optgroup>
        </select>
      </SettingRow>
      <SettingRow label="Accent Color">
        <div className="flex gap-2">
          {ACCENT_COLOR_OPTIONS.map((accent) => {
            const selected = settings.general.accentColor === accent.id;
            return (
              <button
                key={accent.id}
                type="button"
                title={accent.label}
                aria-label={accent.label}
                onClick={() => {
                  void updateSettings({ general: { accentColor: accent.id } });
                }}
                className={`h-6 w-6 rounded-full border transition-shadow active:scale-90 ${
                  selected ? 'border-white fleet-accent-ring-pane' : 'border-fleet-border-strong'
                }`}
                style={{ backgroundColor: accent.value }}
              />
            );
          })}
        </div>
      </SettingRow>
      <TerminalBackgroundSettings />
    </div>
  );
}
